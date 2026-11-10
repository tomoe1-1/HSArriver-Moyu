"""Bundle the workbench into the existing server's single HTML entry point.

No Node, external fonts, CDN, or new HTTP routes are required. The existing
control-source.html contributes only its script, preserving the control API.
"""

import argparse
import base64
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
WEB = ROOT / "web"


def build():
    shell = (WEB / "workbench.html").read_text(encoding="utf-8")
    css = (WEB / "workbench.css").read_text(encoding="utf-8")
    workbench = (WEB / "workbench.js").read_text(encoding="utf-8")
    legacy = (WEB / "control-source.html").read_text(encoding="utf-8")
    scripts = re.findall(r"<script>([\s\S]*?)</script>", legacy)
    if len(scripts) != 1:
        raise ValueError("Expected exactly one existing control script")
    controller = scripts[0]
    # 氛围背景使用纯 CSS 渐变，不再内联任何外部图片素材。
    icon = base64.b64encode((WEB / "assets" / "brand-icon.svg").read_bytes()).decode("ascii")
    if shell.count("__BRAND_ICON__") != 4:
        raise ValueError("Expected favicon and three brand icon placements")
    shell = shell.replace("__BRAND_ICON__", "data:image/svg+xml;base64," + icon)
    ids = re.findall(r'\bid="([^"]+)"', shell)
    if len(ids) != len(set(ids)):
        raise ValueError("Duplicate element IDs in workbench.html")
    needed = set(re.findall(r'\$\("([^\"]+)"\)', controller + workbench))
    missing = needed - set(ids)
    if missing:
        raise ValueError("Missing control elements: " + ", ".join(sorted(missing)))
    for marker, content in (
        ("__INLINE_CSS__", css),
        ("__CONTROL_SCRIPT__", controller),
        ("__WORKBENCH_SCRIPT__", workbench),
    ):
        if shell.count(marker) != 1:
            raise ValueError("Expected one template marker: " + marker)
        shell = shell.replace(marker, content)
    return shell


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="Check that index.html is up to date")
    args = parser.parse_args()
    html = build()
    output = WEB / "index.html"
    if args.check:
        if not output.is_file() or output.read_text(encoding="utf-8") != html:
            parser.exit(1, "Frontend bundle is out of date. Run: python tools/build_web.py\n")
        print("OK: frontend bundle is up to date")
    else:
        output.write_text(html, encoding="utf-8", newline="\n")
        print(f"Built web/index.html ({len(html.encode('utf-8')):,} bytes)")


if __name__ == "__main__":
    main()
