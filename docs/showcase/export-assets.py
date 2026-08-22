#!/usr/bin/env python3
"""导出 README 用 PNG，并写入来自插件清单的作者元数据。

HUD 状态变更后先重跑 render-states.mjs 再跑本脚本：

    node docs/showcase/render-states.mjs
    python3 docs/showcase/export-assets.py

版本注入：导出时自动从事实源读取版本号，拼成 ?hudver=…&cliver=… 附加到页面
URL，两个页面的 inline script 据此覆盖各自的默认常量——HUD 版本取自
kimi.plugin.json 的 version 字段（窗口标题栏 "Kimi Code Hud <版本>"），
Kimi Code 基线版本取自 CAPABILITIES.md 中 "- Kimi Code baseline: …" 一行
（欢迎框 "Version:" 行），避免截图里手写版本号漂移。

公开输出（均为 device_scale_factor=2 截图）：
- docs/media/hud-demo.png：startup-page .window 元素截图（不含投影）；
- docs/media/hud-states.png：states-gallery 窗口 + 四周 L0 青色画布边距（含窗口投影）。

若两张 PNG 的像素已经正确，只补作者元数据即可：

    python3 docs/showcase/export-assets.py --metadata-only

该模式不需要 Playwright；它只规范化标准 PNG tEXt Author 块，保留 IDAT 数据，
重复运行会得到完全相同的文件。
"""
import argparse
import json
import re
import struct
import zlib
from pathlib import Path
from urllib.parse import urlencode


HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"
AUTHOR_KEYWORD = b"Author"


def load_manifest():
    """读取公开导出的版本与作者事实源。"""
    plugin = json.loads((ROOT / "kimi.plugin.json").read_text(encoding="utf-8"))
    cli_match = re.search(
        r'- Kimi Code baseline: `["\']?([0-9][0-9.]*)["\']?`',
        (ROOT / "CAPABILITIES.md").read_text(encoding="utf-8"),
    )
    if cli_match is None:
        raise ValueError("CAPABILITIES.md 缺少 Kimi Code baseline")
    author = plugin.get("author")
    if not isinstance(author, str) or not author:
        raise ValueError("kimi.plugin.json 的 author 必须是非空字符串")
    try:
        author.encode("latin-1")
    except UnicodeEncodeError as error:
        raise ValueError("PNG tEXt Author 必须可编码为 Latin-1") from error
    return plugin["version"], cli_match.group(1), author


def png_chunk(chunk_type, payload):
    """构造带标准 CRC 的 PNG chunk。"""
    checksum = zlib.crc32(chunk_type + payload) & 0xFFFFFFFF
    return struct.pack(">I", len(payload)) + chunk_type + payload + struct.pack(">I", checksum)


def text_keyword(chunk_type, payload):
    """返回 PNG 文本 chunk 的关键字；非文本 chunk 返回 None。"""
    if chunk_type not in {b"tEXt", b"zTXt", b"iTXt"}:
        return None
    return payload.split(b"\x00", 1)[0]


def set_png_author(path, author):
    """规范化 PNG Author 文本块，不重新编码或改写图像数据。"""
    data = path.read_bytes()
    if not data.startswith(PNG_SIGNATURE):
        raise ValueError(f"不是 PNG 文件: {path}")

    chunks = []
    offset = len(PNG_SIGNATURE)
    saw_ihdr = False
    saw_iend = False
    while offset < len(data):
        if offset + 12 > len(data):
            raise ValueError(f"PNG chunk 头不完整: {path}")
        length = struct.unpack(">I", data[offset : offset + 4])[0]
        end = offset + 12 + length
        if end > len(data):
            raise ValueError(f"PNG chunk 数据不完整: {path}")
        chunk_type = data[offset + 4 : offset + 8]
        payload = data[offset + 8 : offset + 8 + length]
        chunk = data[offset:end]
        offset = end

        if chunk_type == b"IHDR":
            if saw_ihdr or chunks:
                raise ValueError(f"PNG IHDR 位置无效: {path}")
            saw_ihdr = True
            chunks.append(chunk)
            author_payload = AUTHOR_KEYWORD + b"\x00" + author.encode("latin-1")
            chunks.append(png_chunk(b"tEXt", author_payload))
        elif text_keyword(chunk_type, payload) == AUTHOR_KEYWORD:
            continue
        else:
            chunks.append(chunk)

        if chunk_type == b"IEND":
            saw_iend = True
            if offset != len(data):
                raise ValueError(f"PNG IEND 后存在额外数据: {path}")

    if not saw_ihdr or not saw_iend:
        raise ValueError(f"PNG 缺少 IHDR 或 IEND: {path}")
    path.write_bytes(PNG_SIGNATURE + b"".join(chunks))


def public_targets():
    """返回仅面向公开 README 的两个导出目标。"""
    return [
        (HERE / "startup-page.html", ROOT / "docs" / "media" / "hud-demo.png", None),
        (HERE / "states-gallery.html", ROOT / "docs" / "media" / "hud-states.png", 56),
    ]


def export_pngs(hud_version, cli_version):
    """用既有 Playwright 截图链生成两张公开 PNG。"""
    try:
        from playwright.sync_api import sync_playwright
    except ModuleNotFoundError as error:
        raise SystemExit("完整导出需要 Python Playwright；仅补元数据可用 --metadata-only") from error

    query = urlencode({"hudver": hud_version, "cliver": cli_version})
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(channel="chrome")
        for html, out, padding in public_targets():
            out.parent.mkdir(parents=True, exist_ok=True)
            page = browser.new_page(
                viewport={"width": 2000, "height": 1400}, device_scale_factor=2
            )
            page.goto(f"{html.as_uri()}?{query}", wait_until="load")
            window = page.locator(".window")
            if padding is None:
                window.screenshot(path=str(out))
            else:
                box = window.bounding_box()
                if box is None:
                    raise RuntimeError(f"找不到 .window 元素: {html}")
                page.screenshot(
                    path=str(out),
                    clip={
                        "x": box["x"] - padding,
                        "y": box["y"] - padding,
                        "width": box["width"] + 2 * padding,
                        "height": box["height"] + 2 * padding,
                    },
                )
            page.close()
            print(f"已导出 {out}")
        browser.close()


def parse_args():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--metadata-only",
        action="store_true",
        help="只为现有两张 docs/media PNG 规范化 Author 元数据",
    )
    return parser.parse_args()


def main():
    args = parse_args()
    hud_version, cli_version, author = load_manifest()
    targets = public_targets()
    if not args.metadata_only:
        export_pngs(hud_version, cli_version)
    for _, output, _ in targets:
        if not output.is_file():
            raise FileNotFoundError(f"PNG 不存在: {output}")
        set_png_author(output, author)
        print(f"已写入 Author={author}: {output}")


if __name__ == "__main__":
    main()
