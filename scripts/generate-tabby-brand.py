#!/usr/bin/env python3
"""Rebuild the approved Tabby A2 logo kit as outlined SVG and PNG files.

Dependencies: cairosvg, Pillow, fonttools[woff] (including Brotli).
The repository's existing InterVariable.woff2 is the only font source.
No network calls, external image generation, live SVG text or raster embedding.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import shutil
import struct
from xml.sax.saxutils import escape


REPO = Path(__file__).resolve().parents[1]
DEFAULT_OUTPUT = REPO / "frontend/public/brand/tabby"
FONT = REPO / "frontend/components/landing/fonts/InterVariable.woff2"
FONT_LICENSE = FONT.with_name("Inter-LICENSE.txt")
ORANGE = "#ff5900"
BLACK = "#202020"
PAPER = "#f1f0ee"
WHITE = "#ffffff"
# Approved A2 master: six 16-unit modules, 6-unit gaps, 2-unit corner radii.
MODULES = ((20, 20), (42, 20), (64, 20), (42, 42), (42, 64), (64, 64))
FONT_AXES = {"wght": 550, "opsz": 32}
TRACKING = -40  # Font units, after Inter's own kerning; optical logo spacing.


def number(value: float) -> str:
    return f"{value:.2f}".rstrip("0").rstrip(".")


def svg_document(title: str, width: int, height: int, body: str,
                 viewbox: str | None = None) -> str:
    vb = viewbox or f"0 0 {width} {height}"
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{vb}" '
            f'width="{width}" height="{height}" role="img" aria-labelledby="title">\n'
            f'  <title id="title">{escape(title)}</title>\n{body}\n</svg>\n')


def symbol_markup(color: str, transform: str = "translate(-10 -10)") -> str:
    rects = "".join(f'<rect x="{x}" y="{y}" width="16" height="16" rx="2"/>'
                    for x, y in MODULES)
    return f'  <g id="symbol" fill="{color}" transform="{transform}">{rects}</g>'


def pair_kern(font, first: str, second: str) -> float:
    """Read instantiated Inter GPOS pair adjustments without a shaping dependency."""
    if "GPOS" not in font:
        return 0
    table = font["GPOS"].table
    indices = sorted({i for feature in table.FeatureList.FeatureRecord
                      if feature.FeatureTag == "kern"
                      for i in feature.Feature.LookupListIndex})
    adjustment = 0
    for index in indices:
        lookup = table.LookupList.Lookup[index]
        subtables = lookup.SubTable
        if lookup.LookupType == 9:
            subtables = [sub.ExtSubTable for sub in subtables if sub.ExtensionLookupType == 2]
        elif lookup.LookupType != 2:
            continue
        for subtable in subtables:
            if first not in subtable.Coverage.glyphs:
                continue
            if subtable.Format == 1:
                pair_set = subtable.PairSet[subtable.Coverage.glyphs.index(first)]
                records = [record for record in pair_set.PairValueRecord
                           if record.SecondGlyph == second]
            else:
                first_class = subtable.ClassDef1.classDefs.get(first, 0)
                second_class = subtable.ClassDef2.classDefs.get(second, 0)
                records = [subtable.Class1Record[first_class].Class2Record[second_class]]
            adjustment += sum(getattr(record.Value1, "XAdvance", 0) for record in records)
    return adjustment


class Wordmark:
    def __init__(self):
        from fontTools.ttLib import TTFont
        from fontTools.varLib.instancer import instantiateVariableFont
        from fontTools.pens.boundsPen import BoundsPen

        self.font = instantiateVariableFont(TTFont(FONT), FONT_AXES, inplace=False)
        self.glyphs = self.font.getGlyphSet()
        self.upem = self.font["head"].unitsPerEm
        cmap = self.font.getBestCmap()
        names = [cmap[ord(character)] for character in "Tabby"]
        cursor = 0
        self.positions = []
        boxes = []
        for index, name in enumerate(names):
            self.positions.append((name, cursor))
            pen = BoundsPen(self.glyphs)
            self.glyphs[name].draw(pen)
            left, bottom, right, top = pen.bounds
            boxes.append((left + cursor, bottom, right + cursor, top))
            cursor += self.font["hmtx"].metrics[name][0]
            if index + 1 < len(names):
                cursor += TRACKING + pair_kern(self.font, name, names[index + 1])
        self.bounds = (min(box[0] for box in boxes), min(box[1] for box in boxes),
                       max(box[2] for box in boxes), max(box[3] for box in boxes))
        cap = BoundsPen(self.glyphs)
        self.glyphs[cmap[ord("T")]].draw(cap)
        self.cap_height = cap.bounds[3] - cap.bounds[1]

    def size(self, em: float) -> tuple[float, float]:
        left, bottom, right, top = self.bounds
        return ((right - left) * em / self.upem, (top - bottom) * em / self.upem)

    def markup(self, color: str, em: float, left: float, top: float) -> str:
        from fontTools.pens.svgPathPen import SVGPathPen
        from fontTools.pens.transformPen import TransformPen

        scale = em / self.upem
        x_min, _, _, y_max = self.bounds
        baseline = top + y_max * scale
        paths = []
        for name, cursor in self.positions:
            pen = SVGPathPen(self.glyphs, ntos=number)
            transformed = TransformPen(pen, (scale, 0, 0, -scale,
                                            left + (cursor - x_min) * scale, baseline))
            self.glyphs[name].draw(transformed)
            paths.append(f'<path d="{pen.getCommands()}"/>')
        return f'  <g id="wordmark" fill="{color}">' + "".join(paths) + "</g>"


def horizontal_markup(word: Wordmark, symbol_color: str, text_color: str) -> tuple[int, str]:
    """Align the symbol to the capital T, excluding the y descender from alignment."""
    text_width, text_height = word.size(60)
    cap_height = word.cap_height * 60 / word.upem
    top = (80 - text_height) / 2
    scale = cap_height / 60
    word_left = 10 + cap_height + 16
    width = math.ceil(word_left + text_width + 10)
    transform = f"translate({number(10 - 20 * scale)} {number(top - 20 * scale)}) scale({number(scale)})"
    body = symbol_markup(symbol_color, transform) + "\n" + word.markup(text_color, 60, word_left, top)
    return width, body


def tile_markup(side: int, fill: str = ORANGE, mark_fraction: float = .64) -> str:
    """Opaque full-bleed tile; OS/browser supplies its own crop or corner shape."""
    scale = side * mark_fraction / 60
    # Original approved artwork bounds are 20..80. Keep it centred, without redrawing.
    offset = (side - side * mark_fraction) / 2 - 20 * scale
    return (f'  <rect width="{side}" height="{side}" fill="{PAPER}"/>\n'
            + symbol_markup(fill, f"translate({number(offset)} {number(offset)}) scale({number(scale)})"))


def favicon_markup() -> str:
    # Pixel-aligned 16 px cut: same six modules and topology. Module=4 px, gap=1 px,
    # radius=.5 px. No module is removed; 32/48 px exports are exact integer multiples.
    rects = "".join(f'<rect x="{x}" y="{y}" width="4" height="4" rx=".5"/>'
                    for x, y in ((1, 1), (6, 1), (11, 1), (6, 6), (6, 11), (11, 11)))
    return (f'  <rect width="16" height="16" fill="{PAPER}"/>\n'
            f'  <g id="symbol" fill="{ORANGE}">{rects}</g>')


def build(output: Path) -> None:
    # Bundled macOS renderer libraries, when present. Other platforms use their own Cairo.
    bundled_cairo = Path.home() / ".cache/codex-runtimes/codex-primary-runtime/dependencies/native/poppler/poppler/lib"
    if bundled_cairo.exists():
        os.environ.setdefault("DYLD_FALLBACK_LIBRARY_PATH", str(bundled_cairo))
    import cairosvg
    from PIL import Image

    output.mkdir(parents=True, exist_ok=True)
    word = Wordmark()
    manifest = []

    def deliver(name: str, raw: str, width: int, height: int, background: str,
                usage: str) -> None:
        svg_path = output / f"{name}.svg"
        png_path = output / f"{name}.png"
        svg_path.write_text(raw, encoding="utf-8")
        cairosvg.svg2png(bytestring=raw.encode(), write_to=str(png_path),
                        output_width=width, output_height=height)
        with Image.open(png_path) as image:
            image.save(png_path, optimize=True)
        for path, fmt in ((svg_path, "svg"), (png_path, "png")):
            size = path.stat().st_size
            if fmt == "png" and size >= 2 * 1024 * 1024:
                raise ValueError(f"PNG too large: {path}")
            manifest.append({"file": path.name, "format": fmt,
                             "pixel_size": [width, height] if fmt == "png" else None,
                             "background": background, "usage": usage, "bytes": size,
                             "sha256": hashlib.sha256(path.read_bytes()).hexdigest()})

    horizontal_width, _ = horizontal_markup(word, ORANGE, BLACK)
    if horizontal_width != 237:
        raise ValueError(f"Unexpected font/source change: horizontal width {horizontal_width}, expected 237")
    wordmark_width = math.ceil(word.size(60)[0] + 20)

    for variant, symbol_color, text_color in (("color", ORANGE, BLACK),
                                             ("black", BLACK, BLACK),
                                             ("white", WHITE, WHITE)):
        title = f"Tabby A2 {variant}"
        deliver(f"symbol-{variant}", svg_document(title + " symbol", 80, 80,
                                                  symbol_markup(symbol_color)),
                1024, 1024, "transparent", "Compact approved A2 symbol")

        _, text_height = word.size(60)
        _, horizontal_body = horizontal_markup(word, symbol_color, text_color)
        deliver(f"logo-horizontal-{variant}", svg_document(title + " horizontal logo", horizontal_width, 80,
                                                            horizontal_body),
                2000, round(2000 * 80 / horizontal_width), "transparent", "Website header/footer and wide spaces")

        stacked_scale = 112 / 60
        stacked_x = (256 - 112) / 2 - 20 * stacked_scale
        stacked_y = 32 - 20 * stacked_scale
        text_width, _ = word.size(64)
        stacked_body = (symbol_markup(symbol_color,
                                      f"translate({number(stacked_x)} {number(stacked_y)}) scale({number(stacked_scale)})")
                        + "\n" + word.markup(text_color, 64, (256 - text_width) / 2, 165))
        deliver(f"logo-stacked-{variant}", svg_document(title + " stacked logo", 256, 256,
                                                         stacked_body),
                1024, 1024, "transparent", "Square presentations and posters")

        deliver(f"wordmark-{variant}", svg_document(title + " wordmark", wordmark_width, 80,
                                                    word.markup(text_color, 60, 10, (80 - text_height) / 2)),
                2000, round(2000 * 80 / wordmark_width), "transparent", "Outlined Tabby wordmark only")

    for side in (16, 32, 48):
        deliver(f"favicon-{side}", svg_document(f"Tabby A2 favicon {side}", side, side,
                                                favicon_markup(), "0 0 16 16"),
                side, side, PAPER, "Pixel-aligned favicon")
    deliver("favicon", svg_document("Tabby A2 favicon", 64, 64, favicon_markup(), "0 0 16 16"),
            64, 64, PAPER, "Scalable browser favicon; generic PNG is 64 px")
    # Build the ICO from exact-size PNGs rather than resizing a single large raster.
    ico_path = output / "favicon.ico"
    # Same portable PNG-in-ICO structure used by logo-design/render_png.py.
    blobs = [(side, (output / f"favicon-{side}.png").read_bytes()) for side in (16, 32, 48)]
    offset = 6 + 16 * len(blobs)
    entries = []
    for side, blob in blobs:
        entries.append(struct.pack("<BBBBHHII", side, side, 0, 0, 1, 32, len(blob), offset))
        offset += len(blob)
    ico_path.write_bytes(struct.pack("<HHH", 0, 1, len(blobs)) + b"".join(entries)
                         + b"".join(blob for _, blob in blobs))
    manifest.append({"file": "favicon.ico", "format": "ico", "pixel_size": [[16, 16], [32, 32], [48, 48]],
                     "background": PAPER, "usage": "Legacy browser favicon", "bytes": ico_path.stat().st_size,
                     "sha256": hashlib.sha256(ico_path.read_bytes()).hexdigest()})

    for name, side, fraction, usage in (
            ("apple-touch-icon", 180, .64, "Apple home-screen icon"),
            ("app-icon-192", 192, .64, "Web app icon 192 px"),
            ("app-icon-512", 512, .64, "Web app icon 512 px"),
            ("maskable-512", 512, .50, "Maskable icon; all modules inside central 80% diameter safe circle"),
            ("brand-square", 1024, .64, "Square brand icon for registration and avatars")):
        deliver(name, svg_document("Tabby A2 " + usage, side, side, tile_markup(side, mark_fraction=fraction)),
                side, side, PAPER, usage)

    # Fully vector social/README artwork; the font outlines are baked into the paths.
    social_scale = 3.2
    social_x = (1200 - horizontal_width * social_scale) / 2
    social_y = (630 - 80 * social_scale) / 2
    _, text_height = word.size(60)
    social_body = (f'  <rect width="1200" height="630" fill="{PAPER}"/>\n'
                   f'  <g transform="translate({number(social_x)} {number(social_y)}) scale({number(social_scale)})">\n'
                   + horizontal_markup(word, ORANGE, BLACK)[1]
                   + "\n  </g>")
    deliver("social-card", svg_document("Tabby A2 social preview", 1200, 630, social_body),
            1200, 630, PAPER, "Link previews, project README and presentation title")

    shutil.copyfile(FONT_LICENSE, output / "Inter-LICENSE.txt")
    (output / "asset-manifest.json").write_text(json.dumps({
        "brand": "Tabby", "approved_concept": "A2 Queue T", "colors": {
            "orange": ORANGE, "black": BLACK, "paper": PAPER, "white": WHITE},
        "font": {"source": str(FONT.relative_to(REPO)), "axes": FONT_AXES,
                 "tracking_font_units": TRACKING, "license": "SIL OFL 1.1; see Inter-LICENSE.txt",
                 "svg_text": "outlined paths"},
        "assets": manifest}, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    readme = """# Tabby A2 品牌资产

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
"""
    for asset in manifest:
        if asset["format"] != "png":
            continue
        size = " × ".join(str(value) for value in asset["pixel_size"])
        background = "透明" if asset["background"] == "transparent" else "暖白"
        readme += f'| `{Path(asset["file"]).stem}` | {size} | {background} |\n'
    readme += "\n另有 `favicon.ico`（16 / 32 / 48 px）、`asset-manifest.json`（尺寸、用途、SHA-256）、`Inter-LICENSE.txt`（字体原始许可）与本文件。\n"
    (output / "README.md").write_text(readme, encoding="utf-8")

    print(json.dumps({"output": str(output), "asset_count": len(manifest),
                      "horizontal_viewbox": [horizontal_width, 80], "wordmark_viewbox": [wordmark_width, 80],
                      "maximum_png_bytes": max(asset["bytes"] for asset in manifest if asset["format"] == "png")},
                     ensure_ascii=False))


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    arguments = parser.parse_args()
    build(arguments.output.resolve())


if __name__ == "__main__":
    main()
