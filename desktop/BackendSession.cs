using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;

namespace HSArriver.Desktop
{
    internal sealed class BackendReady
    {
        internal Uri Url;
        internal int Pid;
        internal string Token;
        internal bool IsAdmin;
        internal bool Owned;
    }

    internal sealed class BackendSession
    {
        private readonly string root;
        private readonly object logLock = new object();
        private readonly SemaphoreSlim startLock = new SemaphoreSlim(1, 1);
        private Process process;
        private Process interpreter;
        private bool stopping;
        internal BackendReady Ready;
        internal string PythonPath;
        internal event Action<string> Progress;
        internal event Action<string> Exited;
        internal string LogFile { get { return Path.Combine(root, "log", "desktop", "desktop.log"); } }
        internal bool HasProcess
        {
            get { return Alive(process) || Alive(interpreter); }
        }
        private static bool Alive(Process value) { try { return value != null && !value.HasExited; } catch { return false; } }
        internal bool Owned { get { return process != null && (Ready == null || Ready.Owned); } }

        internal BackendSession(string rootDirectory) { root = rootDirectory; }

        internal void Log(string text)
        {
            try
            {
                lock (logLock)
                {
                    Directory.CreateDirectory(Path.GetDirectoryName(LogFile));
                    File.AppendAllText(LogFile, DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + "  " + text + Environment.NewLine, Encoding.UTF8);
                }
            }
            catch { }
        }

        private void Report(string text)
        {
            Log(text);
            Action<string> callback = Progress;
            if (callback != null) callback(text);
        }

        internal static Dictionary<string, object> Parse(string text)
        {
            return new JavaScriptSerializer { MaxJsonLength = 4 * 1024 * 1024 }.Deserialize<Dictionary<string, object>>(text);
        }

        internal static string StringValue(Dictionary<string, object> data, string key)
        {
            object value;
            return data != null && data.TryGetValue(key, out value) && value != null ? Convert.ToString(value) : "";
        }

        internal static bool BoolValue(Dictionary<string, object> data, string key)
        {
            object value;
            return data != null && data.TryGetValue(key, out value) && value is bool && (bool)value;
        }

        internal static bool SameRoot(string first, string second)
        {
            try { return String.Equals(Path.GetFullPath(first).TrimEnd('\\'), Path.GetFullPath(second).TrimEnd('\\'), StringComparison.OrdinalIgnoreCase); }
            catch { return false; }
        }

        private string ResolvePython()
        {
            string configured = Environment.GetEnvironmentVariable("HS_PYTHON");
            if (!String.IsNullOrWhiteSpace(configured))
            {
                if (!File.Exists(configured)) throw new FileNotFoundException("HS_PYTHON 指定的解释器不存在：" + configured);
                return Path.GetFullPath(configured);
            }
            string config = Path.Combine(root, "log", "env.json");
            if (File.Exists(config))
            {
                configured = StringValue(Parse(File.ReadAllText(config, Encoding.UTF8)), "interpreter");
                if (!String.IsNullOrWhiteSpace(configured) && File.Exists(configured)) return Path.GetFullPath(configured);
            }
            string local = Path.Combine(root, ".venv", "Scripts", "python.exe");
            if (File.Exists(local)) return local;
            throw new FileNotFoundException("找不到 Python 3.12 后端环境。请保留项目的 .venv，或通过 log/env.json 指定解释器。");
        }

        internal static bool LocalUrl(Uri uri)
        {
            return uri != null && uri.Scheme == "http" && uri.Host == "127.0.0.1" && uri.Port >= 1 && uri.Port <= 65535;
        }

        // Loopback HTTP only. No proxy, redirects, or HTTPS certificate setup.
        private static Dictionary<string, object> Request(Uri url, string endpoint, object body)
        {
            if (!LocalUrl(url)) throw new InvalidOperationException("后端地址必须是本机 127.0.0.1。");
            HttpWebRequest request = (HttpWebRequest)WebRequest.Create(new Uri(url, endpoint));
            request.Proxy = null;
            request.AllowAutoRedirect = false;
            request.Timeout = 5000;
            request.ReadWriteTimeout = 5000;
            request.KeepAlive = false;
            if (body != null)
            {
                request.Method = "POST";
                request.ContentType = "application/json; charset=utf-8";
                byte[] bytes = Encoding.UTF8.GetBytes(new JavaScriptSerializer().Serialize(body));
                request.ContentLength = bytes.Length;
                using (Stream stream = request.GetRequestStream()) stream.Write(bytes, 0, bytes.Length);
            }
            using (WebResponse response = request.GetResponse())
            using (StreamReader reader = new StreamReader(response.GetResponseStream(), Encoding.UTF8))
                return Parse(reader.ReadToEnd());
        }

        private BackendReady FindExisting()
        {
            try
            {
                string file = Path.Combine(root, "log", "ui_port.txt");
                if (!File.Exists(file)) return null;
                Dictionary<string, object> data = Parse(File.ReadAllText(file, Encoding.UTF8));
                if (!SameRoot(StringValue(data, "root"), root)) return null;
                Uri url;
                if (!Uri.TryCreate(StringValue(data, "url"), UriKind.Absolute, out url) || !LocalUrl(url)) return null;
                int pid;
                if (!Int32.TryParse(StringValue(data, "pid"), out pid)) return null;
                Dictionary<string, object> state = Request(url, "/api/status", null);
                if (!SameRoot(StringValue(state, "project_root"), root)) return null;
                Process existing = Process.GetProcessById(pid);
                if (existing.HasExited) { existing.Dispose(); return null; }
                process = existing;
                return new BackendReady { Url = url, Pid = pid, Token = StringValue(data, "token"), IsAdmin = BoolValue(state, "is_admin"), Owned = false };
            }
            catch { return null; }
        }

        internal async Task<BackendReady> StartAsync()
        {
            await startLock.WaitAsync();
            try
            {
                if (Ready != null && HasProcess) return Ready;
                if (HasProcess) throw new InvalidOperationException("后端仍在初始化，请先停止它再重新启动。");
                stopping = false;
                PythonPath = ResolvePython();
                Report("检查已有后端服务…");
                BackendReady existing = await Task.Run(() => FindExisting());
                if (existing != null)
                {
                    Ready = existing;
                    Report("已连接现有后端（不会重复启动）");
                    return existing;
                }
                string host = Path.Combine(root, "desktop", "backend_host.py");
                if (!File.Exists(host)) throw new FileNotFoundException("缺少 desktop/backend_host.py，不能只移动 EXE。");
                Report("启动 Python 3.12 后端…");
                Process child = new Process();
                child.StartInfo = new ProcessStartInfo
                {
                    FileName = PythonPath,
                    Arguments = "-u \"" + host + "\"",
                    WorkingDirectory = root,
                    UseShellExecute = false,
                    CreateNoWindow = true,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    StandardOutputEncoding = Encoding.UTF8,
                    StandardErrorEncoding = Encoding.UTF8
                };
                child.StartInfo.EnvironmentVariables["HS_HOST"] = "127.0.0.1";
                child.StartInfo.EnvironmentVariables["HS_PORT"] = "8765";
                child.StartInfo.EnvironmentVariables["PYTHONUTF8"] = "1";
                child.StartInfo.EnvironmentVariables["PYTHONUNBUFFERED"] = "1";
                TaskCompletionSource<BackendReady> ready = new TaskCompletionSource<BackendReady>();
                child.OutputDataReceived += delegate(object sender, DataReceivedEventArgs e)
                {
                    if (e.Data == null) return;
                    if (!e.Data.StartsWith("HS_DESKTOP ", StringComparison.Ordinal)) { Log(e.Data); return; }
                    try
                    {
                        Dictionary<string, object> data = Parse(e.Data.Substring(11));
                        string kind = StringValue(data, "kind");
                        if (kind == "progress") Report(StringValue(data, "message"));
                        else if (kind == "error") ready.TrySetException(new InvalidOperationException(StringValue(data, "message")));
                        else if (kind == "ready")
                        {
                            Uri url;
                            int pid;
                            if (!Uri.TryCreate(StringValue(data, "url"), UriKind.Absolute, out url) || !LocalUrl(url) || !SameRoot(StringValue(data, "root"), root) || !Int32.TryParse(StringValue(data, "pid"), out pid) || !ProcessIdentity.IsLaunchedInterpreter(pid, child))
                                throw new InvalidOperationException("后端就绪信息与本应用不匹配。");
                            if (pid != child.Id) interpreter = Process.GetProcessById(pid);
                            ready.TrySetResult(new BackendReady { Url = url, Pid = pid, Token = StringValue(data, "token"), IsAdmin = BoolValue(data, "is_admin"), Owned = true });
                        }
                    }
                    catch (Exception error) { ready.TrySetException(error); }
                };
                child.ErrorDataReceived += delegate(object sender, DataReceivedEventArgs e) { if (e.Data != null) Log(e.Data); };
                child.EnableRaisingEvents = true;
                child.Exited += delegate
                {
                    ready.TrySetException(new InvalidOperationException("后端进程退出，请查看桌面日志。"));
                    if (process == child && !stopping)
                    {
                        Action<string> callback = Exited;
                        if (callback != null) callback("后端已退出，可以点击「启动后端」重试。");
                    }
                };
                Ready = null;
                process = child;
                child.Start();
                child.BeginOutputReadLine();
                child.BeginErrorReadLine();
                if (await Task.WhenAny(ready.Task, Task.Delay(45000)) != ready.Task)
                    throw new TimeoutException("后端 45 秒内未就绪。请查看日志；重新启动前需停止仍在初始化的后端。");
                Ready = await ready.Task;
                Dictionary<string, object> health = await Task.Run(() => Request(Ready.Url, "/api/status", null));
                if (!SameRoot(StringValue(health, "project_root"), root)) throw new InvalidOperationException("后端项目目录校验失败。");
                Report("后端已就绪：" + Ready.Url.AbsoluteUri);
                return Ready;
            }
            finally { startLock.Release(); }
        }

        internal Task<Dictionary<string, object>> StatusAsync()
        {
            if (Ready == null) throw new InvalidOperationException("后端尚未就绪。");
            return Task.Run(() => Request(Ready.Url, "/api/status", null));
        }

        // Permission repair can include an existing same-project backend, but
        // only after the desktop user explicitly confirms interruption. Unlike
        // owned children, an external process is NEVER force-killed.
        internal async Task StopConfirmedExistingAsync()
        {
            if (Owned) { await StopOwnedAsync(); return; }
            if (!HasProcess) { Ready = null; return; }
            if (Ready == null || String.IsNullOrWhiteSpace(Ready.Token))
                throw new InvalidOperationException("无法安全停止已有后端，请先从原窗口退出它。");
            Dictionary<string, object> state = await StatusAsync();
            if (!SameRoot(StringValue(state, "project_root"), root))
                throw new InvalidOperationException("已有后端不属于本项目，已拒绝停止。");
            Report("经确认，正在退出本项目的普通权限后端…");
            Dictionary<string, object> stopped = await Task.Run(() => Request(Ready.Url, "/api/serve/stop", new { token = Ready.Token }));
            if (!BoolValue(stopped, "ok")) throw new InvalidOperationException("已有后端拒绝退出，未执行强制结束。");
            Process existing = process;
            if (!await Task.Run(() => existing.WaitForExit(15000)))
                throw new TimeoutException("已有后端仍在退出，未强制结束它。请等它退出后再试。");
            Ready = null;
            process = null;
            existing.Dispose();
        }

        // Called only after an explicit desktop stop/restart/close confirmation,
        // or by the isolated smoke test for the child it created.
        internal async Task StopOwnedAsync()
        {
            if (!HasProcess) { Ready = null; return; }
            if (!Owned) throw new InvalidOperationException("当前连接的是外部启动的后端，本软件不会结束它。");
            Process child = process;
            stopping = true;
            Report("正在停止本软件启动的后端…");
            try
            {
                if (Ready != null && !String.IsNullOrWhiteSpace(Ready.Token))
                {
                    try { await Task.Run(() => Request(Ready.Url, "/api/serve/stop", new { token = Ready.Token })); }
                    catch (Exception error) { Log("后端自停请求：" + error.Message); }
                }
                bool exited = await Task.Run(() => child.WaitForExit(12000));
                if (!exited && !child.HasExited)
                {
                    // Exact Process object created by this application. Never
                    // kill by name, a game process, or an externally owned PID.
                    if (Alive(interpreter)) interpreter.Kill();
                    if (Alive(child)) child.Kill();
                    await Task.Run(() => child.WaitForExit(3000));
                    Log("本软件的后端无响应，已结束其进程；未关闭炉石。");
                }
            }
            finally
            {
                Ready = null;
                process = null;
                if (interpreter != null) { interpreter.Dispose(); interpreter = null; }
                child.Dispose();
                Report("后端已停止");
            }
        }
    }
}
