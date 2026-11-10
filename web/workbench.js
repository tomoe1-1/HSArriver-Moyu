"use strict";

/* UI-only state. All automation continues through the original controller. */
var WORKBENCH_VIEWS = {
  overview: { title: "运行概览", eyebrow: "OVERVIEW", description: "" },
  battle: { title: "对战控制", eyebrow: "BATTLE CONTROL", description: "准备环境，开始对战，或在当前对局结束后安全停止。" },
  schedule: { title: "定时计划", eyebrow: "SCHEDULE", description: "把时间安排好，其余交给工作台。" },
  strategy: { title: "投降与段位", eyebrow: "BATTLE STRATEGY", description: "设置 AI 胜率、对方卡组识别与段位目标。" },
  safety: { title: "运行保护", eyebrow: "RUNTIME PROTECTION", description: "进程检测、日志告警与受限重启，让异常有迹可循。" },
  delays: { title: "延时与活人感", eyebrow: "TIMING & BEHAVIOR", description: "调整识别和操作节奏，下一次动作读取当前配置。" },
  setup: { title: "账号与校准", eyebrow: "ENVIRONMENT SETUP", description: "确认当前账号、日志位置与画面坐标。" },
  environment: { title: "环境自检", eyebrow: "SYSTEM DIAGNOSTICS", description: "从真实检查结果出发，先修复问题，再开始对战。" },
  statistics: { title: "对战统计", eyebrow: "BATTLE STATISTICS", description: "本次运行的对局与胜率，不使用演示数据。" },
  logs: { title: "日志中心", eyebrow: "LOG CENTER", description: "搜索、筛选与导出当前页面接收到的运行日志。" },
  about: { title: "关于工作台", eyebrow: "ABOUT THIS WORKBENCH", description: "免费、开源、本地运行。" }
};
var activeWorkbenchView = "overview";
var activeMonitorTab = "status";
var workbenchScrolls = {};
var workbenchSelfcheck = null;
var desktopPermissions = null;
var selfcheckRefreshPending = false;
var workbenchOnline = null;
var offlineDisabledStates = new Map();
var UI_STORAGE_PREFIX = "hsWorkbench.";
var API_BUTTON_IDS = ["btnStart", "btnOverlay", "btnAfterGame", "btnStopNow", "btnSchedule", "btnCancelSched", "btnCheckLog", "btnCalibrate", "btnSelfcheck", "btnSaveConcede", "btnSaveRankStop", "btnSaveLiveness", "btnSaveWatchdog", "btnSaveHumanLike", "btnSaveDelays", "btnSaveSurrender"];

function uiRead(key, fallback) {
  try { return localStorage.getItem(UI_STORAGE_PREFIX + key) || fallback; }
  catch (e) { return fallback; }
}
function uiWrite(key, value) {
  try { localStorage.setItem(UI_STORAGE_PREFIX + key, value); } catch (e) {}
}
function uiText(id, text) { $(id).textContent = text; }
function desktopMessage(action, data) {
  var bridge = window.chrome && window.chrome.webview;
  if (bridge && typeof bridge.postMessage === "function") bridge.postMessage(Object.assign({action:action}, data || {}));
}
function setDesktopPermissions(data) {
  if (!data || typeof data.frontend_admin !== "boolean" || typeof data.backend_admin !== "boolean") return;
  desktopPermissions = data;
  $("desktopPermissionStatus").hidden = false;
  uiText("desktopPermissionStatus", "前端权限：" + (data.frontend_admin ? "管理员" : "普通") + " · 后端权限：" + (data.backend_admin ? "管理员" : "普通") + "。游戏点击取决于后端权限。");
  if (workbenchSelfcheck) renderChecks($("selfcheckList"), workbenchSelfcheck.items);
}

function navigateWorkbench(view, remember, focusHeading) {
  if (!Object.prototype.hasOwnProperty.call(WORKBENCH_VIEWS, view)) view = "overview";
  var scroll = $("workspaceScroll");
  workbenchScrolls[activeWorkbenchView] = scroll.scrollTop;
  activeWorkbenchView = view;
  var metadata = WORKBENCH_VIEWS[view];
  document.querySelectorAll("[data-view]").forEach(function(section) {
    section.hidden = section.dataset.view.split(" ").indexOf(view) < 0;
  });
  document.querySelectorAll("[data-nav]").forEach(function(button) {
    var selected = button.dataset.nav === view;
    if (button.classList.contains("rail-item") && button.dataset.nav === "overview") {
      selected = ["overview", "battle", "schedule", "strategy", "safety", "delays"].indexOf(view) >= 0;
    }
    button.classList.toggle("active", selected);
    if (selected) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  });
  $("viewHeading").hidden = view === "overview";
  uiText("viewBreadcrumb", metadata.title);
  uiText("viewTitle", metadata.title);
  uiText("viewEyebrow", metadata.eyebrow);
  uiText("viewDescription", metadata.description);
  document.title = "HSArriver Turbo · " + metadata.title;
  if (view === "logs") {
    $("logPageHost").appendChild($("cardLogs"));
    $("monitor").hidden = true;
    document.querySelector(".workbench-layout").classList.add("logs-wide");
  } else {
    $("monitorLogsHost").appendChild($("cardLogs"));
    $("monitor").hidden = false;
    document.querySelector(".workbench-layout").classList.remove("logs-wide");
  }
  $("btnExpandLogs").hidden = view === "logs";
  if (remember !== false) uiWrite("view", view);
  scroll.scrollTop = workbenchScrolls[view] || 0;
  setMenuOpen(false);
  if (focusHeading) $("workspace").focus({ preventScroll: true });
}

function setMenuOpen(open) {
  document.body.classList.toggle("menu-open", open);
  $("btnMenu").setAttribute("aria-expanded", String(open));
  $("btnMenu").setAttribute("aria-label", open ? "关闭导航" : "打开导航");
  $("navScrim").hidden = !open;
}

function setMonitorTab(tab, remember) {
  activeMonitorTab = tab === "logs" ? "logs" : "status";
  $("monitorStatus").hidden = activeMonitorTab !== "status";
  $("monitorLogsHost").hidden = activeMonitorTab !== "logs";
  ["Status", "Logs"].forEach(function(name) {
    var selected = name.toLowerCase() === activeMonitorTab;
    var button = $("tab" + name);
    button.classList.toggle("active", selected);
    button.setAttribute("aria-selected", String(selected));
    button.tabIndex = selected ? 0 : -1;
  });
  if (remember !== false) uiWrite("monitorTab", activeMonitorTab);
  if (activeMonitorTab === "logs" && $("chkAutoscroll").checked) {
    $("logBox").scrollTop = $("logBox").scrollHeight;
  }
}

function applyTheme(theme, remember) {
  theme = theme === "light" ? "light" : "dark";
  document.documentElement.dataset.theme = theme;
  var label = theme === "dark" ? "切换亮色主题" : "切换暗色主题";
  $("btnTheme").setAttribute("aria-label", label);
  $("btnTheme").title = label;
  $("btnTheme").querySelector("use").setAttribute("href", theme === "dark" ? "#i-sun" : "#i-moon");
  document.querySelector('meta[name="theme-color"]').content = theme === "dark" ? "#10191e" : "#f0f5f7";
  if (remember !== false) uiWrite("theme", theme);
  desktopMessage("theme", {value:theme});
}

function applyBackdrop(enabled, remember) {
  document.body.classList.toggle("no-backdrop", !enabled);
  $("btnBackdrop").setAttribute("aria-pressed", String(enabled));
  if (remember !== false) uiWrite("backdrop", enabled ? "on" : "off");
}

function setConnection(online) {
  if (workbenchOnline === online) return;
  workbenchOnline = online;
  ["connectionDot", "monitorConnectionDot", "monitorLiveDot"].forEach(function(id) {
    $(id).classList.toggle("online", online);
    $(id).classList.toggle("offline", !online);
  });
  uiText("connectionText", online ? "本地服务已连接" : "本地服务连接已断开");
  uiText("monitorConnection", online ? "本地服务已连接" : "服务离线 · 数据已过期");
  $("connectionNotice").hidden = online;
  if (!online) {
    API_BUTTON_IDS.forEach(function(id) {
      var button = $(id);
      offlineDisabledStates.set(button, button.disabled);
      button.disabled = true;
    });
    uiText("controlTitle", "本地服务连接已断开");
    uiText("controlDescription", "检查控制台是否运行；下方状态是最后一次接收的数据。");
  } else {
    offlineDisabledStates.forEach(function(disabled, button) { button.disabled = disabled; });
    offlineDisabledStates.clear();
  }
}

function setHealth(name, text, state) {
  uiText("health" + name, text);
  $("health" + name).className = state || "";
  $("health" + name + "Dot").className = "state-dot " + (state || "");
}

function renderWorkbench(s) {
  var running = s.phase === "playing" || s.phase === "stopping";
  var busy = running || !!s.starting;
  var config = s.config || {};
  if (!s.starting) uiText("btnStart", s.prepared ? "开始对战" : "开始运行（准备）");
  uiText("btnOverlay", "日志浮窗（" + (s.overlay_running ? "开" : "关") + "）");
  var name = config.name || "未设置账号";
  var logRoot = config.log_root || "尚未填写日志目录";
  uiText("overviewAccount", name);
  uiText("overviewPath", logRoot);
  $("overviewPath").title = logRoot;
  $("scriptDot").className = "state-dot " + (running ? "ok" : s.starting ? "warn" : "");
  uiText("navBattleState", s.starting ? "准备中" : running ? "运行中" : s.prepared ? "已就绪" : "待机");
  var phase = s.starting ? "正在准备" : running ? (s.state_label || "运行中") : s.phase === "waiting" ? "等待定时启动" : s.prepared ? "已就绪" : "待机中";
  var hint = s.starting ? "正在启动环境，请稍候" : running ? "跟随盒子建议执行操作" : s.prepared ? "浮窗已打开，可开始对战" : "自动化尚未开始";
  uiText("monitorPhase", phase);
  uiText("monitorPhaseHint", hint);
  uiText("controlTitle", s.starting ? "正在准备运行环境…" : running ? "自动化运行中 · " + (s.state_label || "等待日志") : s.prepared ? "环境已准备，随时开始对战" : s.phase === "waiting" ? "定时任务已设置，等待开始" : "工作台已连接，等待准备");
  uiText("controlDescription", running ? (s.stop_after_game ? "本局结束后将停止，不再开启下一局。" : "请保持游戏与盒子可见，可随时暂停运行。") : s.prepared ? "开始后会自动匹配与出牌，操作前需要确认。" : "先准备环境，再开始对战。准备不会自动开打。");
  $("controlOrb").classList.toggle("running", running);

  setHealth("Admin", s.is_admin ? "已提权" : "未提权", s.is_admin ? "ok" : "bad");
  var envItems = workbenchSelfcheck && workbenchSelfcheck.items ? workbenchSelfcheck.items.filter(function(item) {
    return /Python|pywin32|opencv|numpy|Pillow|paddle|psutil|keyboard|pynput|Requests|click|setuptools|mcp/i.test(item.label || "");
  }) : [];
  var envFailed = envItems.filter(function(item) { return item.status === "fail"; }).length;
  setHealth("Env", envItems.length ? (envFailed ? envFailed + " 项待修" : "3.12 · 依赖正常") : "读取自检中", envItems.length ? envFailed ? "bad" : "ok" : "");
  var lv = s.liveness || {};
  var gameState = lv.status === "ok" ? "ok" : (lv.status === "gone" || lv.status === "stale") ? "bad" : lv.status === "warning" ? "warn" : "";
  setHealth("Game", gameState === "ok" ? "正在运行" : gameState === "bad" ? "已退出 / 无响应" : gameState === "warn" ? "日志停滞" : "等待检测", gameState);
  var nm = s.name_match || {};
  setHealth("Name", nm.matched === true ? "匹配" : nm.matched === false ? "不匹配" : "等待对局", nm.matched === true ? "ok" : nm.matched === false ? "bad" : "");
  var logAge = lv.log_age;
  setHealth("Log", logAge != null && Number.isFinite(Number(logAge)) ? Math.round(logAge) + "s 前更新" : "等待更新", logAge != null ? gameState : "");
  uiText("monitorProtection", lv.enabled ? "已启用" : "已关闭");
  uiText("monitorWatchdog", s.watchdog && s.watchdog.enabled ? "已启用" : "已关闭");
  uiText("monitorConcede", s.concede && s.concede.enabled ? "低于 " + s.concede.threshold + "%" : "已关闭");
  uiText("monitorRank", s.rank_stop && s.rank_stop.enabled ? s.rank_stop.mode === "legend_number" ? "传说 " + s.rank_stop.legend_number + " 名" : "上传说就停" : "未设置");

  var accountReady = !!(config.name && config.log_root);
  $("readyAccountIcon").className = "step-index " + (accountReady ? "ok" : "");
  uiText("readyAccountIcon", accountReady ? "✓" : "01");
  uiText("readyAccountStatus", accountReady ? "已配置" : "待配置");
  $("readyAccountStatus").className = "step-status " + (accountReady ? "ok" : "");
  uiText("readyAccountText", accountReady ? "当前账号：" + config.name : "填写战网昵称和炉石 Logs 目录");
  var sc = s.selfcheck || {};
  if (sc.checked_at && workbenchSelfcheck && sc.checked_at !== workbenchSelfcheck.checked_at && !selfcheckRefreshPending) {
    selfcheckRefreshPending = true;
    get("/api/selfcheck").then(function(response) {
      selfcheckRefreshPending = false;
      if (response.ok) renderSelfcheck(response.result);
    });
  }
  var checkFailed = Number(sc.failed) || 0;
  var checked = !!sc.checked;
  $("readyEnvIcon").className = "step-index " + (checked ? checkFailed ? "bad" : "ok" : "");
  uiText("readyEnvIcon", checked && !checkFailed ? "✓" : "02");
  uiText("readyEnvStatus", checked ? checkFailed ? checkFailed + " 项待修" : "检查通过" : "检测中");
  $("readyEnvStatus").className = "step-status " + (checked ? checkFailed ? "bad" : "ok" : "");
  uiText("readyEnvText", checked && sc.summary ? sc.summary : "Python 3.12 / 管理员权限 / 依赖");
  uiText("navCheckBadge", checked ? checkFailed ? String(checkFailed) : "✓" : "—");
  $("navCheckBadge").className = "nav-badge " + (checked ? checkFailed ? "bad" : "ok" : "");

  var scheduled = !!(s.schedule_start && (s.phase === "waiting" || running));
  $("scheduleMarker").hidden = !scheduled;
  uiText("scheduleState", scheduled ? s.phase === "waiting" ? "等待开始" : "计划运行中" : "未设置");
  uiText("scheduleSummary", scheduled ? "开始：" + s.schedule_start + (s.schedule_end ? " · 结束：" + s.schedule_end : " · 无结束时间") : "当前没有定时计划。");

  /* Preserve the original runtime locks, including fields formerly unlocked. */
  ["chkConcede", "inpConcedeThreshold", "inpConcedeRounds", "btnSaveConcede", "inpReadyDelay", "inpPostOcrDelay", "inpRetryDelay", "inpFirstTurnPerCard", "inpPreDelay", "inpPostDelay", "inpDrawDelay", "inpChoiceTargetDelay", "inpOcrScale", "btnSaveDelays", "btnCalibrate"].forEach(function(id) { $(id).disabled = busy; });
  if (document.activeElement !== $("inpName") && document.activeElement !== $("inpLog") && !dirty.name && !dirty.log) updateConfigSaveState("自动保存");

  var games = Math.max(0, Number(s.games) || 0);
  var wins = Math.max(0, Math.min(games, Number(s.wins) || 0));
  var losses = games - wins;
  var rate = games ? wins / games * 100 : 0;
  uiText("chartWins", wins);
  uiText("chartLosses", losses);
  uiText("donutValue", games ? rate.toFixed(1).replace(/\.0$/, "") + "%" : "—");
  $("winDonut").style.background = games ? "conic-gradient(var(--accent) " + rate + "%, var(--border-soft) 0)" : "var(--border-soft)";
  $("winBar").style.width = rate + "%";
  $("lossBar").style.width = (games ? 100 - rate : 0) + "%";
  uiText("statisticsNote", games ? "已完成 " + games + " 场对局。数据来自当前运行进程。" : "尚无已完成的对局，开始运行后显示真实统计。");
  desktopMessage("ui-ready", {phase:s.phase, running:!!s.running});
}

function updateConfigSaveState(label) { uiText("configSaveState", label); }

function filterWorkbenchNavigation() {
  var query = $("navSearch").value.trim().toLowerCase();
  var matched = 0;
  document.querySelectorAll(".catalog-group").forEach(function(group) {
    var count = 0;
    group.querySelectorAll(".nav-item").forEach(function(button) {
      var view = WORKBENCH_VIEWS[button.dataset.nav];
      var text = button.textContent + " " + (view ? view.description : "");
      button.hidden = query && text.toLowerCase().indexOf(query) < 0;
      if (!button.hidden) count++;
    });
    group.hidden = !count;
    matched += count;
  });
  $("navEmpty").hidden = matched > 0;
}

function filterWorkbenchLogs() {
  var query = $("logSearch").value.trim().toLowerCase();
  var level = $("logLevel").value;
  var lines = $("logBox").querySelectorAll(".log-line");
  var visible = 0;
  lines.forEach(function(line) {
    line.hidden = (level !== "all" && !line.classList.contains("log-" + level)) || (query && line.textContent.toLowerCase().indexOf(query) < 0);
    if (!line.hidden) visible++;
  });
  uiText("logCount", lines.length);
  uiText("logVisibleCount", query || level !== "all" ? visible + " / " + lines.length + " 条记录" : lines.length + " 条记录");
  $("logBox").hidden = !visible;
  $("logEmpty").hidden = !!visible;
  $("logEmpty").querySelector("strong").textContent = lines.length ? "没有匹配的日志" : "暂无日志";
  $("logEmpty").querySelector("p").textContent = lines.length ? "试试其他关键词或级别" : "运行消息会显示在这里";
}

/* Decorate renders, do not introduce another backend polling loop. */
var controlRender = render;
render = function(s) { setConnection(true); controlRender(s); renderWorkbench(s); };
var controlSelfcheckRender = renderSelfcheck;
renderSelfcheck = function(result) {
  controlSelfcheckRender(result);
  workbenchSelfcheck = result;
  if (lastStatus && workbenchOnline !== false) renderWorkbench(lastStatus);
};

document.addEventListener("click", function(event) {
  var desktopAction = event.target.closest("[data-desktop-action]");
  if (desktopAction && desktopAction.dataset.desktopAction === "admin") desktopMessage("request-admin");
  var nav = event.target.closest("[data-nav]");
  if (nav) navigateWorkbench(nav.dataset.nav, true, nav.classList.contains("rail-item"));
});
$("btnMenu").addEventListener("click", function() { setMenuOpen(!document.body.classList.contains("menu-open")); });
$("navScrim").addEventListener("click", function() { setMenuOpen(false); });
$("btnTheme").addEventListener("click", function() { applyTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark"); });
$("btnBackdrop").addEventListener("click", function() { applyBackdrop(document.body.classList.contains("no-backdrop")); });
$("tabStatus").addEventListener("click", function() { setMonitorTab("status"); });
$("tabLogs").addEventListener("click", function() { setMonitorTab("logs"); });
document.querySelector(".segmented-tabs").addEventListener("keydown", function(event) {
  if (["ArrowLeft", "ArrowRight", "Home", "End"].indexOf(event.key) < 0) return;
  event.preventDefault();
  setMonitorTab(event.key === "Home" ? "status" : event.key === "End" ? "logs" : activeMonitorTab === "status" ? "logs" : "status");
  $(activeMonitorTab === "status" ? "tabStatus" : "tabLogs").focus();
});
$("navSearch").addEventListener("input", filterWorkbenchNavigation);
$("logSearch").addEventListener("input", filterWorkbenchLogs);
$("logLevel").addEventListener("change", filterWorkbenchLogs);
["inpName", "inpLog"].forEach(function(id) { $(id).addEventListener("input", function() { updateConfigSaveState("未保存"); }); });
document.addEventListener("keydown", function(event) {
  var editing = /INPUT|TEXTAREA|SELECT/.test(event.target.tagName) || event.target.isContentEditable;
  if (event.key === "/" && !editing && !event.ctrlKey && !event.altKey && !event.metaKey) {
    event.preventDefault();
    if (window.matchMedia("(max-width: 760px)").matches) setMenuOpen(true);
    $("navSearch").focus();
  }
  if (event.key === "Escape") {
    setMenuOpen(false);
    if (event.target === $("navSearch")) {
      $("navSearch").value = "";
      filterWorkbenchNavigation();
      $("navSearch").blur();
    }
  }
});
$("btnExportLog").addEventListener("click", function() {
  var lines = Array.from($("logBox").querySelectorAll(".log-line")).filter(function(line) { return !line.hidden; });
  if (!lines.length) { toast("当前没有可导出的日志", "warn"); return; }
  var content = lines.map(function(line) {
    return Array.from(line.children).map(function(cell) { return cell.textContent; }).join(" ");
  }).join("\r\n");
  var url = URL.createObjectURL(new Blob(["\ufeff", content], { type: "text/plain;charset=utf-8" }));
  var link = document.createElement("a");
  link.href = url;
  link.download = "HSArriver_页面日志_" + new Date().toISOString().replace(/[:.]/g, "-") + ".txt";
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
});
new MutationObserver(filterWorkbenchLogs).observe($("logBox"), { childList: true });
applyTheme(uiRead("theme", "dark"), false);
applyBackdrop(uiRead("backdrop", "on") === "on", false);
setMonitorTab(uiRead("monitorTab", "status"), false);
navigateWorkbench(uiRead("view", "overview"), false);
filterWorkbenchLogs();
if (lastStatus) renderWorkbench(lastStatus);
