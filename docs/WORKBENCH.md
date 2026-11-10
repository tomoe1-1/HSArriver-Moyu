# 炉石工作台前端

## 使用

桌面软件入口是项目根目录的 **`HSArriver.exe`**：双击即在独立窗口内打开工作台，
并自动拉起后端。原生工具栏可启动 / 停止 / 重启后端；详见 `desktop/README.md`。

沿用 `web_ui.py` 的本地地址与全部控制接口。启动控制台后刷新页面即可，
不需要单独启动 Node 服务。准备与开始对战仍是两步操作，风险操作保留确认。

- 桌面：导航栏、功能目录、工作区、状态 / 日志侧栏。
- 窄窗口：自动收起目录和监控栏，菜单按钮可打开全部配置。
- 统计仅使用当前控制台返回的数据；零对局时不展示虚构图表。
- 日志中心支持关键词、级别筛选、导出；清空只清除页面记录，不删除日志文件。
- 亮暗主题、背景开关、页面选择保存在本浏览器。
- 断开连接时保留旧数据并明确提示；服务端操作按钮暂停使用。

## 开发

源文件位于 `web/workbench.html`、`web/workbench.css`、`web/workbench.js`。
`web/control-source.html` 保留原页面作为控制器兼容性源码：构建只取其中的 JS，
旧布局不会被加入新页面。`web/index.html` 是可直接部署的生成入口。

```powershell
python tools/build_web.py
python tools/build_web.py --check
python -m unittest tests.test_web_workbench tests.test_surrender_frontend
```

构建只需 Python 标准库，会检查重复 / 缺失的元素 ID，并把样式、脚本和素材嵌入
一个 HTML。没有 CDN、在线字体或新增后端路由；服务端进程不需要因外观更新而重启。

`tests/frontend_workbench_browser.js` 提供真实 Chromium 交互与响应式回归。
需有 Playwright 和 Microsoft Edge；也可通过 `PLAYWRIGHT_MODULE` 与
`HS_TEST_BROWSER` 指定模块或浏览器位置。全部 API 均在测试浏览器中拦截，
不访问真实账号、不修改真实配置，也不操作游戏。

## 设计与素材

参考用户提供的 OASX 2.4.0 的青蓝中性表面、多栏工作台、分段监控标签与背景构图。
图标按用户提供的黑色三旋、青蓝环图案手工制作 SVG；非原图逐像素复制。
素材说明见 `web/assets/README.md`。OASX 原安装目录没有被修改。
