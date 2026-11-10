using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Threading.Tasks;
using System.Web;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace HSArriver.Desktop
{
    internal sealed class MainWindow : Form
    {
        private readonly string root;
        private readonly bool smoke;
        private readonly BackendSession backend;
        private readonly WebView2 browser;
        private readonly ToolStrip toolbar;
        private readonly ToolStripLabel serviceLabel;
        private readonly ToolStripLabel ownerLabel;
        private readonly ToolStripButton startButton;
        private readonly ToolStripButton stopButton;
        private readonly ToolStripButton restartButton;
        private readonly ToolStripButton adminButton;
        private readonly ToolStripButton reloadButton;
        private readonly TaskCompletionSource<bool> uiReady = new TaskCompletionSource<bool>();
        private bool starting;
        private bool closing;
        private bool allowClose;
        private Uri backendUrl;
        private string sentPermissions;
        private CoreWebView2Environment environment;

        [DllImport("dwmapi.dll")]
        private static extern int DwmSetWindowAttribute(IntPtr hwnd, int attribute, ref int value, int size);

        internal MainWindow(string rootDirectory, bool smokeTest)
        {
            root = rootDirectory;
            smoke = smokeTest;
            backend = new BackendSession(root);
            Text = "HSArriver Turbo · 桌面工作台";
            Size = new Size(1440, 960);
            MinimumSize = new Size(980, 680);
            StartPosition = FormStartPosition.CenterScreen;
            BackColor = Color.FromArgb(13, 22, 28);
            Font = new Font("Segoe UI", 9F);
            using (Stream stream = Assembly.GetExecutingAssembly().GetManifestResourceStream("HSArriver.Desktop.Icon"))
                Icon = new Icon(stream);
            browser = new WebView2 { Dock = DockStyle.Fill, DefaultBackgroundColor = BackColor };
            toolbar = new ToolStrip { Dock = DockStyle.Top, AutoSize = false, Height = 38, GripStyle = ToolStripGripStyle.Hidden, Padding = new Padding(10, 3, 10, 3), Renderer = new ToolStripProfessionalRenderer(new DesktopColors()) };
            serviceLabel = new ToolStripLabel("●  后端未启动") { ForeColor = Color.FromArgb(237, 194, 131), Margin = new Padding(6, 0, 16, 0) };
            ownerLabel = new ToolStripLabel("") { ForeColor = Color.FromArgb(163, 180, 191), Margin = new Padding(0, 0, 14, 0) };
            startButton = Button("启动后端", async delegate { await StartBackendAsync(true); });
            stopButton = Button("停止后端", async delegate { await StopBackendAsync(); });
            restartButton = Button("重启后端", async delegate { await RestartBackendAsync(); });
            reloadButton = Button("刷新界面", delegate { if (backendUrl != null) browser.CoreWebView2.Navigate(backendUrl.AbsoluteUri); });
            adminButton = Button("以管理员重新打开", async delegate { await RestartElevatedAsync(); });
            adminButton.Alignment = ToolStripItemAlignment.Right;
            ToolStripButton logs = Button("启动日志", delegate { OpenLogs(); });
            logs.Alignment = ToolStripItemAlignment.Right;
            toolbar.Items.AddRange(new ToolStripItem[] { serviceLabel, ownerLabel, startButton, stopButton, restartButton, reloadButton, new ToolStripSeparator(), logs, adminButton });
            Controls.Add(browser);
            Controls.Add(toolbar);
            ApplyTheme("dark");
            SetControls(false);
            backend.Progress += delegate(string message)
            {
                Dispatch(delegate
                {
                    if (starting)
                    {
                        serviceLabel.Text = "●  " + message;
                        if (browser.CoreWebView2 != null)
                            browser.CoreWebView2.ExecuteScriptAsync("if(document.getElementById('desktopMessage')) document.getElementById('desktopMessage').textContent=" + Json(message) + ";");
                    }
                });
            };
            backend.Exited += delegate(string message)
            {
                Dispatch(delegate
                {
                    if (closing) return;
                    SetControls(false);
                    ShowPage("后端已退出", message, false);
                });
            };
            Shown += OnShown;
            FormClosing += OnClosing;
        }

        private ToolStripButton Button(string text, Action action)
        {
            ToolStripButton button = new ToolStripButton(text) { DisplayStyle = ToolStripItemDisplayStyle.Text, AutoToolTip = true, Margin = new Padding(3, 0, 3, 0) };
            button.Click += delegate { action(); };
            return button;
        }

        private static string Json(object data) { return new JavaScriptSerializer().Serialize(data); }
        private static bool IsAdmin()
        {
            try { return new WindowsPrincipal(WindowsIdentity.GetCurrent()).IsInRole(WindowsBuiltInRole.Administrator); }
            catch { return false; }
        }
        private void Dispatch(Action action)
        {
            if (IsDisposed || !IsHandleCreated) return;
            try { if (InvokeRequired) BeginInvoke(action); else action(); } catch (InvalidOperationException) { }
        }
        private static string ResourceText(string name)
        {
            using (Stream stream = Assembly.GetExecutingAssembly().GetManifestResourceStream(name))
            using (StreamReader reader = new StreamReader(stream)) return reader.ReadToEnd();
        }

        private async void OnShown(object sender, EventArgs args)
        {
            Exception startupError = null;
            try
            {
                string profile = Path.Combine(root, "log", "desktop", "webview-profile");
                Directory.CreateDirectory(profile);
                environment = await CoreWebView2Environment.CreateAsync(null, profile);
                await browser.EnsureCoreWebView2Async(environment);
                browser.CoreWebView2.Settings.IsStatusBarEnabled = false;
                browser.CoreWebView2.Settings.AreDevToolsEnabled = false;
                browser.CoreWebView2.Settings.IsZoomControlEnabled = true;
                browser.CoreWebView2.NavigationStarting += OnNavigation;
                browser.CoreWebView2.NewWindowRequested += delegate(object s, CoreWebView2NewWindowRequestedEventArgs e) { e.Handled = true; OpenExternal(e.Uri); };
                browser.CoreWebView2.PermissionRequested += delegate(object s, CoreWebView2PermissionRequestedEventArgs e) { e.State = CoreWebView2PermissionState.Deny; };
                browser.CoreWebView2.WebMessageReceived += OnWebMessage;
                browser.CoreWebView2.DocumentTitleChanged += delegate { if (backendUrl != null) Text = browser.CoreWebView2.DocumentTitle + " · 桌面版"; };
                await StartBackendAsync(false);
                if (smoke) await RunSmokeTestAsync();
            }
            catch (Exception error)
            {
                backend.Log(error.ToString());
                startupError = error;
            }
            if (startupError != null)
            {
                if (smoke) { await FinishSmokeAsync(false, startupError.ToString()); return; }
                if (browser.CoreWebView2 != null) ShowPage("桌面应用初始化失败", startupError.Message, false);
                else MessageBox.Show(this, "WebView2 初始化失败：\n" + startupError.Message + "\n\n请安装 Microsoft Edge WebView2 Runtime，并检查 desktop/runtime 文件。", Text, MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        }

        private bool TrustedSource(string source)
        {
            if (source == "about:blank") return true;
            Uri url;
            return backendUrl != null && Uri.TryCreate(source, UriKind.Absolute, out url) && BackendSession.LocalUrl(url) && url.Port == backendUrl.Port;
        }
        private void OnNavigation(object sender, CoreWebView2NavigationStartingEventArgs e)
        {
            if (e.Uri == "about:blank") return;
            Uri uri;
            if (backendUrl != null && Uri.TryCreate(e.Uri, UriKind.Absolute, out uri) && BackendSession.LocalUrl(uri) && uri.Port == backendUrl.Port)
            {
                sentPermissions = null;
                return;
            }
            e.Cancel = true;
            OpenExternal(e.Uri);
        }
        private void OpenExternal(string text)
        {
            Uri uri;
            if (!Uri.TryCreate(text, UriKind.Absolute, out uri) || (uri.Scheme != "https" && uri.Scheme != "http") || uri.IsLoopback) return;
            try { Process.Start(new ProcessStartInfo(uri.AbsoluteUri) { UseShellExecute = true }); }
            catch (Exception error) { backend.Log(error.Message); }
        }
        private async void OnWebMessage(object sender, CoreWebView2WebMessageReceivedEventArgs e)
        {
            if (!TrustedSource(e.Source)) return;
            try
            {
                Dictionary<string, object> message = BackendSession.Parse(e.WebMessageAsJson);
                string action = BackendSession.StringValue(message, "action");
                if (action == "ui-ready")
                {
                    string permissions = Json(new { frontend_admin = IsAdmin(), backend_admin = backend.Ready != null && backend.Ready.IsAdmin });
                    if (sentPermissions != permissions)
                    {
                        sentPermissions = permissions;
                        await browser.CoreWebView2.ExecuteScriptAsync("if(window.setDesktopPermissions) setDesktopPermissions(" + permissions + ");");
                    }
                    uiReady.TrySetResult(true);
                }
                else if (action == "theme") ApplyTheme(BackendSession.StringValue(message, "value"));
                else if (action == "request-admin") await RestartElevatedAsync();
                else if (action == "retry") await StartBackendAsync(true);
                else if (action == "logs") OpenLogs();
            }
            catch (Exception error) { backend.Log(error.Message); }
        }

        private void ShowPage(string title, string message, bool loading)
        {
            if (browser.CoreWebView2 == null) return;
            backendUrl = null;
            string icon = Convert.ToBase64String(System.Text.Encoding.UTF8.GetBytes(ResourceText("HSArriver.Desktop.Brand")));
            string html = ResourceText("HSArriver.Desktop.Loading")
                .Replace("__ICON__", "data:image/svg+xml;base64," + icon)
                .Replace("__TITLE__", HttpUtility.HtmlEncode(title))
                .Replace("__MESSAGE__", HttpUtility.HtmlEncode(message))
                .Replace("__PROGRESS__", loading ? "<div class='progress'><span></span></div>" : "")
                .Replace("__ACTIONS__", loading ? "" : "<button class='primary' onclick=\"action('retry')\">启动 / 重试后端</button><button onclick=\"action('logs')\">打开启动日志</button>");
            browser.CoreWebView2.NavigateToString(html);
            Text = "HSArriver Turbo · 桌面工作台";
        }

        private void SetControls(bool ready)
        {
            startButton.Enabled = !starting && !ready;
            stopButton.Enabled = !starting && backend.HasProcess && backend.Owned;
            restartButton.Enabled = !starting && ready && backend.Owned;
            reloadButton.Enabled = ready;
            adminButton.Enabled = !starting;
            adminButton.Visible = !IsAdmin() || (backend.Ready != null && !backend.Ready.IsAdmin);
            adminButton.Text = IsAdmin() ? "以管理员运行后端" : "以管理员重新打开";
            if (ready)
            {
                serviceLabel.Text = "●  后端运行中";
                serviceLabel.ForeColor = Color.FromArgb(111, 214, 164);
                ownerLabel.Text = "前端" + (IsAdmin() ? "管理员" : "普通") + " / 后端" + (backend.Ready.IsAdmin ? "管理员" : "普通") + " · " + backend.Ready.Url.Port;
            }
            else
            {
                serviceLabel.Text = backend.HasProcess ? "●  后端尚未就绪" : "●  后端未启动";
                serviceLabel.ForeColor = Color.FromArgb(237, 194, 131);
                ownerLabel.Text = "";
            }
        }

        private bool ConfirmStop(string operation)
        {
            return MessageBox.Show(this, operation + "将停止本软件启动的后端和自动化，不会关闭炉石。\n若该后端无响应，会结束它的进程。是否继续？", "HSArriver Turbo", MessageBoxButtons.YesNo, MessageBoxIcon.Warning, MessageBoxDefaultButton.Button2) == DialogResult.Yes;
        }

        private async Task StartBackendAsync(bool userAction)
        {
            if (starting || closing || browser.CoreWebView2 == null) return;
            if (backend.HasProcess && backend.Ready == null)
            {
                if (!userAction || !ConfirmStop("重新启动前")) return;
                await backend.StopOwnedAsync();
            }
            starting = true;
            SetControls(false);
            ShowPage("正在拉起后端", "软件会自动启动项目的 Python 3.12 环境，无需手动命令。", true);
            try
            {
                BackendReady state = await backend.StartAsync();
                if (IsAdmin() && !state.IsAdmin && !smoke && MessageBox.Show(this,
                    "前端已是管理员，但已有后端仍是普通权限。\n是否停止该后端与自动化，并用管理员权限重新拉起？不会关闭炉石。",
                    Text, MessageBoxButtons.YesNo, MessageBoxIcon.Warning, MessageBoxDefaultButton.Button2) == DialogResult.Yes)
                {
                    await backend.StopConfirmedExistingAsync();
                    state = await backend.StartAsync();
                    if (!state.IsAdmin) throw new InvalidOperationException("后端没有获得管理员权限，请检查启动账户；未伪装为权限正常。");
                }
                if (closing) return;
                backendUrl = state.Url;
                browser.CoreWebView2.Navigate(backendUrl.AbsoluteUri);
                starting = false;
                SetControls(true);
            }
            catch (Exception error)
            {
                backend.Log(error.ToString());
                starting = false;
                SetControls(false);
                if (!closing) ShowPage("后端启动失败", error.Message, false);
                if (smoke) throw;
            }
            finally { starting = false; }
        }

        private async Task StopBackendAsync()
        {
            if (starting || closing || !backend.HasProcess || !backend.Owned || !ConfirmStop("停止后端")) return;
            starting = true;
            SetControls(false);
            try { await backend.StopOwnedAsync(); ShowPage("后端已停止", "点击「启动后端」可再次拉起服务；炉石不会被关闭。", false); }
            catch (Exception error) { ShowPage("停止失败", error.Message, false); }
            finally { starting = false; SetControls(false); }
        }
        private async Task RestartBackendAsync()
        {
            if (starting || closing || !backend.Owned || !ConfirmStop("重启后端")) return;
            starting = true;
            SetControls(false);
            try { await backend.StopOwnedAsync(); }
            catch (Exception error) { ShowPage("停止失败", error.Message, false); return; }
            finally { starting = false; }
            await StartBackendAsync(false);
        }

        private async Task RestartElevatedAsync()
        {
            if (starting || closing || smoke) return;
            if (IsAdmin())
            {
                if (backend.Ready != null && backend.Ready.IsAdmin)
                {
                    MessageBox.Show(this, "前端和后端已以管理员身份运行。点击「重新自检」可刷新页面结果。", Text, MessageBoxButtons.OK, MessageBoxIcon.Information);
                    return;
                }
                if (backend.HasProcess && MessageBox.Show(this,
                    "前端已经获得管理员权限。将停止当前本项目后端与自动化，再用相同管理员权限拉起后端。\n不会关闭炉石。是否继续？",
                    Text, MessageBoxButtons.YesNo, MessageBoxIcon.Warning, MessageBoxDefaultButton.Button2) != DialogResult.Yes) return;
                starting = true;
                SetControls(false);
                try { if (backend.HasProcess) await backend.StopConfirmedExistingAsync(); }
                catch (Exception error) { ShowPage("后端权限修复未完成", error.Message, false); return; }
                finally { starting = false; SetControls(false); }
                await StartBackendAsync(false);
                return;
            }
            bool stopBackend = backend.HasProcess && (backend.Ready == null || !backend.Ready.IsAdmin);
            string message = stopBackend
                ? "将停止当前本项目的普通权限后端与自动化，并以前后端管理员权限重新打开。\n不会关闭炉石；取消后可点击「启动后端」重新启动。"
                : "将以前端管理员权限重新打开；已经是管理员的后端会保留，不中断后台任务。";
            message += "\n需要您在 Windows UAC 窗口点击「是」。是否继续？";
            if (MessageBox.Show(this, message, Text, MessageBoxButtons.YesNo, MessageBoxIcon.Warning, MessageBoxDefaultButton.Button2) != DialogResult.Yes) return;
            try
            {
                starting = true;
                SetControls(false);
                if (stopBackend) await backend.StopConfirmedExistingAsync();
                Program.InstanceMutex.ReleaseMutex();
                try
                {
                    Process.Start(new ProcessStartInfo(Assembly.GetExecutingAssembly().Location) { UseShellExecute = true, Verb = "runas", WorkingDirectory = root });
                    allowClose = true;
                    Close();
                }
                catch
                {
                    Program.InstanceMutex.WaitOne(0);
                    throw;
                }
            }
            catch (Exception error) { backend.Log(error.Message); ShowPage("管理员启动未完成", "可能取消了 UAC 授权。" + Environment.NewLine + error.Message, false); }
            finally { starting = false; if (!IsDisposed) SetControls(false); }
        }

        private void OpenLogs()
        {
            try
            {
                Directory.CreateDirectory(Path.GetDirectoryName(backend.LogFile));
                if (!File.Exists(backend.LogFile)) File.WriteAllText(backend.LogFile, "HSArriver Turbo 桌面启动日志\r\n");
                Process.Start(new ProcessStartInfo("explorer.exe", "/select,\"" + backend.LogFile + "\"") { UseShellExecute = true });
            }
            catch (Exception error) { backend.Log(error.Message); }
        }
        private async void OnClosing(object sender, FormClosingEventArgs e)
        {
            if (allowClose || !backend.HasProcess || !backend.Owned) return;
            e.Cancel = true;
            if (closing || (!smoke && !ConfirmStop("退出软件"))) return;
            closing = true;
            try { await backend.StopOwnedAsync(); }
            catch (Exception error) { backend.Log(error.ToString()); }
            finally { allowClose = true; Close(); }
        }

        private void ApplyTheme(string name)
        {
            bool dark = name != "light";
            Color background = dark ? Color.FromArgb(14, 23, 29) : Color.FromArgb(240, 245, 247);
            Color text = dark ? Color.FromArgb(163, 180, 191) : Color.FromArgb(47, 71, 84);
            toolbar.BackColor = background;
            toolbar.ForeColor = text;
            foreach (ToolStripItem item in toolbar.Items) item.ForeColor = text;
            int value = dark ? 1 : 0;
            try { DwmSetWindowAttribute(Handle, 20, ref value, sizeof(int)); } catch { }
            if (backend.Ready != null && backend.HasProcess)
                serviceLabel.ForeColor = dark ? Color.FromArgb(111, 214, 164) : Color.FromArgb(24, 120, 75);
        }

        private async Task RunSmokeTestAsync()
        {
            if (await Task.WhenAny(uiReady.Task, Task.Delay(15000)) != uiReady.Task) throw new TimeoutException("内嵌前端没有完成实际后端连接。");
            Dictionary<string, object> state = await backend.StatusAsync();
            if (BackendSession.StringValue(state, "phase") != "idle" || BackendSession.BoolValue(state, "running")) throw new InvalidOperationException("冒烟测试要求待机状态，不启动或中断对战。");
            string preview = Path.Combine(root, "log", "desktop", "app-preview.png");
            using (FileStream stream = File.Create(preview)) await browser.CoreWebView2.CapturePreviewAsync(CoreWebView2CapturePreviewImageFormat.Png, stream);
            string frontend = await browser.CoreWebView2.ExecuteScriptAsync("({title:document.title,desktopBridge:!!window.chrome.webview,startLabel:document.getElementById('btnStart').textContent})");
            backend.Log("桌面端验证通过：真实后端待机、WebView2 内嵌界面已连接；未操作游戏。");
            string report = Json(new { ok = true, backend_url = backend.Ready.Url.AbsoluteUri, backend_pid = backend.Ready.Pid, owns_backend = backend.Ready.Owned, is_admin = backend.Ready.IsAdmin, python = backend.PythonPath, phase = "idle", browser = environment.BrowserVersionString, frontend = BackendSession.Parse(frontend), preview = preview });
            File.WriteAllText(Path.Combine(root, "log", "desktop", "smoke-result.json"), report, System.Text.Encoding.UTF8);
            await FinishSmokeAsync(true, null);
        }
        private async Task FinishSmokeAsync(bool success, string error)
        {
            closing = true;
            if (!success)
            {
                Directory.CreateDirectory(Path.Combine(root, "log", "desktop"));
                File.WriteAllText(Path.Combine(root, "log", "desktop", "smoke-result.json"), Json(new { ok = false, error = error }), System.Text.Encoding.UTF8);
                Environment.ExitCode = 1;
            }
            try { if (backend.HasProcess && backend.Owned) await backend.StopOwnedAsync(); }
            catch (Exception stopError) { backend.Log(stopError.ToString()); Environment.ExitCode = 1; }
            allowClose = true;
            Close();
        }

        private sealed class DesktopColors : ProfessionalColorTable
        {
            public override Color ToolStripBorder { get { return Color.FromArgb(43, 62, 72); } }
            public override Color ButtonSelectedHighlight { get { return Color.FromArgb(36, 73, 84); } }
            public override Color ButtonSelectedGradientBegin { get { return ButtonSelectedHighlight; } }
            public override Color ButtonSelectedGradientMiddle { get { return ButtonSelectedHighlight; } }
            public override Color ButtonSelectedGradientEnd { get { return ButtonSelectedHighlight; } }
            public override Color ButtonSelectedBorder { get { return Color.FromArgb(90, 144, 163); } }
        }
    }
}
