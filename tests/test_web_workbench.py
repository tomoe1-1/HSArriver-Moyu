"""Offline checks for the self-contained OASX-style workbench bundle."""

import re
import shutil
import subprocess
import unittest
from html.parser import HTMLParser
from pathlib import Path
from xml.etree import ElementTree

from tools.build_web import build

ROOT = Path(__file__).resolve().parent.parent
WEB = ROOT / "web"


class Markup(HTMLParser):
    def __init__(self, html):
        super().__init__()
        self.ids = []
        self.attrs = []
        self.feed(html)

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        self.attrs.append((tag, attrs))
        if "id" in attrs:
            self.ids.append(attrs["id"])


class WorkbenchBundleTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.html = (WEB / "index.html").read_text(encoding="utf-8")
        cls.markup = Markup(cls.html)
        cls.legacy = (WEB / "control-source.html").read_text(encoding="utf-8")

    def test_bundle_is_current(self):
        self.assertTrue(self.html == build(), "Run python tools/build_web.py")

    def test_build_is_deterministic(self):
        self.assertTrue(build() == build())

    def test_no_duplicate_ids(self):
        self.assertEqual(len(self.markup.ids), len(set(self.markup.ids)))

    def test_existing_control_elements_survive(self):
        before = set(Markup(self.legacy).ids)
        self.assertEqual(before - set(self.markup.ids), set())

    def test_all_views_are_reachable(self):
        views = set()
        navigation = set()
        for _, attrs in self.markup.attrs:
            views.update(attrs.get("data-view", "").split())
            if "data-nav" in attrs:
                navigation.add(attrs["data-nav"])
        self.assertEqual(views, navigation)
        self.assertEqual(len(views), 11)

    def test_images_are_embedded(self):
        images = [attrs for tag, attrs in self.markup.attrs if tag == "img"]
        self.assertEqual(len(images), 3)
        self.assertTrue(all(attrs["src"].startswith("data:image/svg+xml;base64,") for attrs in images))
        self.assertIn("data:image/webp;base64,", self.html)

    def test_no_external_runtime_dependencies(self):
        for tag, attrs in self.markup.attrs:
            if tag in ("script", "img"):
                self.assertFalse(attrs.get("src", "").startswith(("http", "/")))
            if tag == "link" and attrs.get("rel") in ("stylesheet", "icon"):
                self.assertTrue(attrs.get("href", "").startswith("data:"))

    def test_no_unexpanded_template_markers(self):
        self.assertFalse(re.search(r"__(?:INLINE|CONTROL|WORKBENCH|OASX|BRAND)_[A-Z_]+__", self.html))

    def test_no_personal_absolute_paths_in_sources(self):
        for filename in ("workbench.html", "workbench.css", "workbench.js"):
            text = (WEB / filename).read_text(encoding="utf-8")
            self.assertNotRegex(text, r"C:\\Users\\|F:\\ls")

    def test_icon_is_a_scalable_three_blade_vector(self):
        root = ElementTree.parse(WEB / "assets" / "brand-icon.svg").getroot()
        self.assertEqual(root.attrib["viewBox"], "0 0 192 192")
        ns = {"svg": "http://www.w3.org/2000/svg"}
        blades = [el for el in root.findall("svg:use", ns) if el.attrib.get("href") == "#blade"]
        self.assertEqual(len(blades), 3)

    def test_accessibility_basics(self):
        for token in ('lang="zh-CN"', 'class="skip-link"', 'aria-label="主导航"', 'role="tablist"', 'role="log"', 'prefers-reduced-motion'):
            self.assertIn(token, self.html)
        for tag, attrs in self.markup.attrs:
            if tag == "img":
                self.assertIn("alt", attrs)

    def test_controller_is_preserved(self):
        controller = re.findall(r"<script>([\s\S]*?)</script>", self.legacy)[0]
        compiled = re.findall(r"<script>([\s\S]*?)</script>", self.html)[0]
        self.assertTrue(controller == compiled)

    def test_workbench_does_not_add_a_polling_loop(self):
        ui = (WEB / "workbench.js").read_text(encoding="utf-8")
        self.assertNotIn("setInterval(", ui)
        self.assertNotRegex(ui, r'post\("/api/')

    def test_workbench_js_syntax(self):
        node = shutil.which("node")
        if not node:
            self.skipTest("Node is optional")
        result = subprocess.run([node, "--check", str(WEB / "workbench.js")], capture_output=True, text=True, timeout=30)
        self.assertEqual(result.returncode, 0, result.stderr)


if __name__ == "__main__":
    unittest.main()
