/* Build-time SVG rasterization only; the installed EXE does not need Node. */
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const root = path.resolve(__dirname, "..");
const output = path.join(root, "desktop", "assets", "brand.png");

(async () => {
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const svg = fs.readFileSync(path.join(root, "web", "assets", "brand-icon.svg"), "utf8");
  const browser = await chromium.launch(process.env.HS_TEST_BROWSER ? { executablePath: process.env.HS_TEST_BROWSER } : { channel: "msedge" });
  try {
    const page = await browser.newPage({ viewport: { width: 256, height: 256 } });
    await page.setContent("<style>html,body{margin:0;background:transparent}svg{width:256px;height:256px;display:block}</style>" + svg);
    await page.locator("svg").screenshot({ path: output, omitBackground: true });
    console.log("Built desktop/assets/brand.png");
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
