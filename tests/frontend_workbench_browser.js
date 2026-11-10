/* Real browser regression, with every request intercepted. Never drives a game. */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const ROOT = path.resolve(__dirname, "..");
const html = fs.readFileSync(path.join(ROOT, "web", "index.html"), "utf8");
const screenshotArgument = process.argv.indexOf("--screenshots");
const screenshots = screenshotArgument >= 0 ? process.argv[screenshotArgument + 1] : null;
if (screenshots) fs.mkdirSync(screenshots, { recursive: true });
const posts = [];
const errors = [];
const checks = [];
let status;
let logLines = [
  { t: "12:00:00", level: "SYS", msg: "工作台初始化完成" },
  { t: "12:00:01", level: "WARN", msg: "测试警告：等待游戏窗口" },
  { t: "12:00:02", level: "INFO", msg: "读取测试配置" },
];
const selfcheck = {
  ok: true, failed: 0, summary: "测试环境检查通过", python: "3.12.14", checked_at: "test",
  items: [
    { label: "Python 3.12（64 位）", status: "ok", detail: "3.12.14" },
    { label: "paddleocr", status: "ok", detail: "测试依赖" },
    { label: "管理员权限", status: "ok", detail: "测试权限" },
  ],
};

function idleStatus() {
  return {
    phase: "idle", running: false, starting: false, prepared: false,
    is_admin: true, state: "", state_label: "待机", overlay_running: false,
    games: 0, wins: 0, win_rate: 0, concede_count: 0, in_game: false,
    schedule_start: null, schedule_end: null,
    config: { name: "测试账号#0000", log_root: "<测试 Logs 目录>" },
    version: { label: "v2026.10.24" },
    selfcheck: { checked: true, failed: 0, ok: true, summary: "测试环境检查通过" },
    name_match: { matched: null, config: "测试账号#0000" },
    liveness: { enabled: true, status: "idle", log_age: null, log_stale_warn_seconds: 120, log_stale_stop_seconds: 300 },
    watchdog: { enabled: false, stale_seconds: 300, max_restarts: 3, status: "idle" },
    concede: { enabled: false, threshold: 20, rounds: 2 },
    rank_stop: { enabled: false, mode: "legend", action: "stop", legend_number: 5000 },
    human_like: { enabled: false, hand_hover_enabled: false, minion_hover_enabled: false, post_delay_min: .5, post_delay_max: 3, hover_min: .2, hover_max: 1, minion_hover_min: .2, minion_hover_max: 1.5 },
    delays: { mulligan_ready_delay_seconds: 5, mulligan_post_ocr_delay_seconds: 1, mulligan_retry_delay_seconds: 2, first_turn_per_card_delay_seconds: 1, pre_action_delay_seconds: 3, post_action_delay_seconds: 1, draw_extra_delay_per_card_seconds: 1, discover_target_delay_seconds: .5, ocr_preprocess_scale: 2 },
    auto_surrender: { enabled: false, aliases: {}, decks: [] },
    surrenders: { decks: [] },
  };
}

async function gotoView(page, view) {
  const rail = page.locator('.nav-rail [data-nav="' + view + '"]');
  const catalog = page.locator('.catalog [data-nav="' + view + '"]');
  if (await rail.count()) await rail.first().click();
  else {
    if (await page.locator("#btnMenu").isVisible()) await page.locator("#btnMenu").click();
    await catalog.first().click();
  }
  await page.waitForFunction(v => activeWorkbenchView === v, view);
}

async function check(name, action) {
  await action();
  checks.push(name);
  console.log("OK:", name);
}

async function main() {
  const browser = await chromium.launch(process.env.HS_TEST_BROWSER ? { executablePath: process.env.HS_TEST_BROWSER, headless: true } : { channel: "msedge", headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, acceptDownloads: true });
    const page = await context.newPage();
    page.on("pageerror", error => errors.push(error.message));
    page.on("dialog", dialog => dialog.accept());
    status = idleStatus();
    await page.route("**/*", async route => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.pathname === "/") return route.fulfill({ contentType: "text/html; charset=utf-8", body: html });
      if (request.method() === "GET") {
        let result;
        if (url.pathname === "/api/status") result = status;
        else if (url.pathname === "/api/selfcheck") result = { ok: true, result: selfcheck };
        else if (url.pathname === "/api/logs") result = { seq: logLines.length, lines: logLines.slice(Number(url.searchParams.get("seq") || 0)) };
        else if (url.pathname === "/api/card_search") result = { ok: true, cards: [{ id: "CS2_029", ids: ["CS2_029"], name: "火球术", class_zh: "法师", type_zh: "法术" }] };
        else if (url.pathname === "/api/check_log") result = { checked: true, power_log_found: true, message: "测试目录通过" };
        else throw new Error("Unexpected GET " + url.pathname);
        return route.fulfill({ json: result });
      }
      const body = request.postDataJSON();
      posts.push({ path: url.pathname, body });
      if (url.pathname === "/api/prepare") { status.prepared = true; status.overlay_running = true; }
      if (url.pathname === "/api/start") { status.phase = "playing"; status.running = true; }
      if (url.pathname === "/api/stop") { status.phase = body.mode === "after_game" ? "stopping" : "idle"; status.running = body.mode === "after_game"; status.stop_after_game = body.mode === "after_game"; }
      if (url.pathname === "/api/config") status.config = body;
      if (url.pathname === "/api/schedule") { status.phase = "waiting"; status.schedule_start = body.start; status.schedule_end = body.end; }
      if (url.pathname === "/api/schedule/cancel") { status.phase = "idle"; status.schedule_start = null; status.schedule_end = null; }
      if (url.pathname === "/api/surrender_rules") status.auto_surrender = body.config;
      return route.fulfill({ json: { ok: true, message: "测试操作完成", result: selfcheck } });
    });
    await page.goto("http://hs-workbench.test/", { waitUntil: "load" });
    await page.locator("#connectionText").filter({ hasText: "本地服务已连接" }).waitFor();
    await page.waitForFunction(() => workbenchSelfcheck !== null);

    await check("boot renders without side effects", async () => {
      assert.equal(posts.length, 0);
      assert.equal(await page.locator("#btnStart").textContent(), "开始运行（准备）");
      assert.equal(await page.locator("#healthAdmin").textContent(), "已提权");
      assert.equal(await page.locator("#stGames").textContent(), "0");
      assert(await page.locator("#logEmpty").isHidden());
    });

    await check("all 11 navigation views preserve their controls", async () => {
      for (const view of ["battle", "schedule", "strategy", "safety", "delays", "setup", "environment", "statistics", "logs", "about", "overview"]) {
        await gotoView(page, view);
        const visible = await page.locator("[data-view]").evaluateAll(nodes => nodes.filter(n => !n.hidden).map(n => n.dataset.view));
        assert(visible.length > 0);
        assert(visible.every(value => value.split(" ").includes(view)));
      }
      assert.equal(await page.locator("#logBox").count(), 1);
    });

    await check("statistics use real supplied counts and an honest empty state", async () => {
      status = { ...idleStatus(), games: 20, wins: 13, win_rate: 65, concede_count: 2 };
      await page.evaluate(() => refreshStatus());
      await page.waitForFunction(() => document.getElementById("chartWins").textContent === "13");
      assert.equal(await page.locator("#chartLosses").textContent(), "7");
      assert.equal(await page.locator("#donutValue").textContent(), "65%");
      status = idleStatus();
      await page.evaluate(() => refreshStatus());
      await page.waitForFunction(() => document.getElementById("donutValue").textContent === "—");
    });

    await check("runtime locks remain locked after offline recovery", async () => {
      status = { ...idleStatus(), phase: "playing", running: true, prepared: true };
      await page.evaluate(() => refreshStatus());
      await page.waitForFunction(() => document.getElementById("btnStopNow").disabled === false);
      await page.evaluate(() => setConnection(false));
      assert(await page.locator("#btnStart").isDisabled());
      await page.evaluate(() => refreshStatus());
      await page.locator("#connectionNotice").waitFor({ state: "hidden" });
      assert(await page.locator("#btnStart").isDisabled());
      assert(await page.locator("#inpPreDelay").isDisabled());
      assert(await page.locator("#btnCalibrate").isDisabled());
      status = idleStatus();
      await page.evaluate(() => refreshStatus());
      await page.waitForFunction(() => !document.getElementById("btnStart").disabled);
    });

    await check("prepare and start remain two separate confirmed actions", async () => {
      await gotoView(page, "battle");
      await page.locator("#btnStart").click();
      await page.waitForFunction(() => document.getElementById("btnStart").textContent === "开始对战");
      assert.equal(posts.at(-1).path, "/api/prepare");
      await page.locator("#btnStart").click();
      await page.waitForFunction(() => document.getElementById("btnStopNow").disabled === false);
      assert.equal(posts.at(-1).path, "/api/start");
      await page.locator("#btnAfterGame").click();
      await page.waitForFunction(() => lastStatus.phase === "stopping");
      assert.deepEqual(posts.at(-1), { path: "/api/stop", body: { mode: "after_game" } });
      await page.locator("#btnStopNow").click();
      await page.waitForFunction(() => lastStatus.phase === "idle");
      assert.equal(posts.at(-1).body.mode, "now");
    });

    await check("config edits survive refresh and save on blur", async () => {
      await gotoView(page, "setup");
      await page.locator("#inpName").fill("新测试账号#0001");
      await page.evaluate(() => refreshStatus());
      assert.equal(await page.locator("#inpName").inputValue(), "新测试账号#0001");
      await page.locator("#inpName").press("Tab");
      await page.waitForFunction(() => !dirty.name);
      assert.equal(posts.at(-1).path, "/api/config");
      assert.equal(posts.at(-1).body.name, "新测试账号#0001");
    });

    await check("all configuration save buttons keep their API wiring", async () => {
      for (const [view, button, endpoint] of [
        ["safety", "btnSaveLiveness", "/api/liveness"],
        ["safety", "btnSaveWatchdog", "/api/watchdog"],
        ["strategy", "btnSaveConcede", "/api/concede"],
        ["strategy", "btnSaveRankStop", "/api/rank_stop"],
        ["delays", "btnSaveDelays", "/api/delays"],
        ["delays", "btnSaveHumanLike", "/api/human_like"],
      ]) {
        await gotoView(page, view);
        await Promise.all([
          page.waitForResponse(response => new URL(response.url()).pathname === endpoint),
          page.locator("#" + button).click(),
        ]);
        assert.equal(posts.at(-1).path, endpoint);
      }
      assert.equal(posts.find(p => p.path === "/api/delays").body.discover_target_delay_seconds, "0.5");
    });

    await check("schedule saves and cancels without triggering a battle", async () => {
      await gotoView(page, "schedule");
      const start = new Date(Date.now() + 3600000).toISOString().slice(0, 16);
      await page.locator("#inpStart").fill(start);
      await page.locator("#btnSchedule").click();
      await page.waitForFunction(() => lastStatus.phase === "waiting");
      assert.equal(posts.at(-1).path, "/api/schedule");
      await page.locator("#btnCancelSched").click();
      await page.waitForFunction(() => lastStatus.phase === "idle");
      assert.equal(posts.at(-1).path, "/api/schedule/cancel");
    });

    await check("card autocomplete is clickable and nested rules survive", async () => {
      await gotoView(page, "strategy");
      await page.locator("#btnAddSurrenderDeck").click();
      const card = page.locator('#surrenderDecks input[data-f="card"]').first();
      await card.fill("火球");
      await page.locator(".scard-item").first().click();
      assert.equal(await card.inputValue(), "火球术");
      await page.locator('#surrenderDecks [data-act="add-group"]').first().click();
      assert.equal(await page.locator('#surrenderDecks [data-depth="1"]').count(), 1);
      await Promise.all([
        page.waitForResponse(r => new URL(r.url()).pathname === "/api/surrender_rules"),
        page.locator("#btnSaveSurrender").click(),
      ]);
      assert.equal(posts.at(-1).body.config.decks[0].when.all[0].card, "火球术");
    });

    await check("log relocation, search, level filtering and export", async () => {
      await gotoView(page, "logs");
      assert.equal(await page.locator("#logBox").count(), 1);
      await page.locator("#logSearch").fill("初始化");
      assert.equal(await page.locator(".log-line:visible").count(), 1);
      const downloadPromise = page.waitForEvent("download");
      await page.locator("#btnExportLog").click();
      const download = await downloadPromise;
      const content = fs.readFileSync(await download.path(), "utf8");
      assert(content.includes("工作台初始化完成"));
      assert(!content.includes("测试警告"));
      await page.locator("#logSearch").fill("");
      await page.locator("#logLevel").selectOption("warn");
      assert.equal(await page.locator(".log-line:visible").count(), 1);
      await page.locator("#logLevel").selectOption("all");
      await gotoView(page, "overview");
      await page.locator("#tabLogs").click();
      assert.equal(await page.locator(".log-line:visible").count(), 3);
      await page.locator("#tabLogs").press("ArrowLeft");
      assert.equal(await page.locator("#tabStatus").getAttribute("aria-selected"), "true");
    });

    await check("theme and backdrop preferences survive reload", async () => {
      await page.locator("#btnTheme").click();
      await page.locator("#btnBackdrop").click();
      await page.reload({ waitUntil: "load" });
      assert.equal(await page.locator("html").getAttribute("data-theme"), "light");
      assert((await page.locator("body").getAttribute("class")).includes("no-backdrop"));
      await page.locator("#btnTheme").click();
      await page.locator("#btnBackdrop").click();
    });

    await check("navigation search and keyboard shortcut", async () => {
      await page.locator("body").press("/");
      assert.equal(await page.locator("#navSearch").evaluate(el => el === document.activeElement), true);
      await page.locator("#navSearch").fill("延时");
      assert.equal(await page.locator(".catalog .nav-item:visible").count(), 1);
      await page.locator("#navSearch").press("Escape");
      assert.equal(await page.locator("#navSearch").inputValue(), "");
    });

    await check("desktop permission card uses native UAC and never fakes backend privileges", async () => {
      const before = posts.length;
      await page.evaluate(() => {
        window.nativePermissionMessages = [];
        window.chrome.webview = { postMessage: message => window.nativePermissionMessages.push(message) };
        setDesktopPermissions({ frontend_admin: true, backend_admin: false });
        renderSelfcheck({ ok: false, failed: 1, summary: "权限待修复", python: "3.12", checked_at: "permission-test", items: [
          { key: "admin", label: "管理员权限", status: "fail", detail: "当前不是管理员", hint: "python web_ui.py" }
        ] });
        navigateWorkbench("environment");
      });
      assert((await page.locator("#desktopPermissionStatus").textContent()).includes("前端权限：管理员 · 后端权限：普通"));
      assert.equal(await page.locator("#selfcheckList .check-item.bad").count(), 1);
      assert(!(await page.locator("#selfcheckList").textContent()).includes("python web_ui.py"));
      await page.locator('[data-desktop-action="admin"]').click();
      assert.equal(await page.evaluate(() => window.nativePermissionMessages.at(-1).action), "request-admin");
      assert.equal(posts.length, before);
      await page.evaluate(result => {
        setDesktopPermissions({ frontend_admin: false, backend_admin: true });
        renderSelfcheck(result);
      }, selfcheck);
      assert(await page.locator('[data-desktop-action="admin"]').isVisible());
      await page.evaluate(() => {
        delete window.chrome.webview;
        desktopPermissions = null;
        document.getElementById("desktopPermissionStatus").hidden = true;
      });
      await gotoView(page, "overview");
    });

    await check("responsive layouts fit at 375 / 768 / 1024 / 1440 / 1920", async () => {
      status = idleStatus();
      await page.evaluate(() => refreshStatus());
      await gotoView(page, "overview");
      for (const [width, height] of [[375, 812], [768, 1024], [1024, 768], [1440, 960], [1920, 1080]]) {
        await page.setViewportSize({ width, height });
        await page.locator("#btnStart").scrollIntoViewIfNeeded();
        const overflow = await page.evaluate(() => Array.from(document.querySelectorAll(".app-header,.workspace,.hero,.metrics,.control-actions,.panel input,.panel select")).filter(el => el.getClientRects().length).filter(el => el.getBoundingClientRect().right > innerWidth + 1).map(el => el.id || el.className));
        assert.deepEqual(overflow, [], width + "px overflow: " + overflow.join(", "));
        assert(await page.locator("#btnStart").isVisible());
        if (width === 375) {
          await page.locator("#btnMenu").click();
          assert(await page.locator("#catalog").isVisible());
          await page.locator('#catalog [data-nav="delays"]').click();
          assert(await page.locator("#inpPreDelay").isVisible());
          await gotoView(page, "overview");
        }
        await page.locator("#workspaceScroll").evaluate(el => el.scrollTop = 0);
        if (screenshots && [375, 1440].includes(width)) await page.screenshot({ path: path.join(screenshots, "workbench-" + width + "-test.png") });
      }
    });
    assert.deepEqual(errors, []);
    console.log("PASS:", checks.length, "browser checks; no real API requests or game operations.");
  } finally { await browser.close(); }
}

main().catch(error => { console.error(error.stack); process.exitCode = 1; });
