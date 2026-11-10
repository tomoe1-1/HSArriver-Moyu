using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Windows.Forms;

[assembly: AssemblyTitle("HSArriver Turbo Desktop")]
[assembly: AssemblyDescription("炉石传说本地桌面工作台与后端启动器")]
[assembly: AssemblyProduct("HSArriver Turbo")]
[assembly: AssemblyVersion("1.0.0.0")]
[assembly: AssemblyFileVersion("1.0.0.0")]

namespace HSArriver.Desktop
{
    internal static class Program
    {
        internal static string Root;
        internal static Mutex InstanceMutex;

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
        private static extern bool SetDllDirectory(string path);
        [DllImport("user32.dll")] private static extern bool SetForegroundWindow(IntPtr hwnd);
        [DllImport("user32.dll")] private static extern bool ShowWindowAsync(IntPtr hwnd, int command);

        [STAThread]
        private static void Main(string[] args)
        {
            Root = AppDomain.CurrentDomain.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar);
            string runtime = Path.Combine(Root, "desktop", "runtime");
            AppDomain.CurrentDomain.AssemblyResolve += delegate(object sender, ResolveEventArgs e)
            {
                string name = new AssemblyName(e.Name).Name;
                if (!name.StartsWith("Microsoft.Web.WebView2", StringComparison.Ordinal)) return null;
                string file = Path.Combine(runtime, name + ".dll");
                return File.Exists(file) ? Assembly.LoadFrom(file) : null;
            };
            SetDllDirectory(runtime);
            string identity;
            using (SHA256 hash = SHA256.Create())
                identity = BitConverter.ToString(hash.ComputeHash(Encoding.UTF8.GetBytes(Root.ToUpperInvariant()))).Replace("-", "").Substring(0, 16);
            bool created;
            InstanceMutex = new Mutex(false, "Local\\HSArriverDesktop_" + identity, out created);
            bool acquired;
            try { acquired = InstanceMutex.WaitOne(0); }
            catch (AbandonedMutexException) { acquired = true; }
            if (!acquired)
            {
                foreach (Process process in Process.GetProcessesByName("HSArriver"))
                {
                    if (process.Id == Process.GetCurrentProcess().Id) continue;
                    try
                    {
                        if (!String.Equals(process.MainModule.FileName, Assembly.GetExecutingAssembly().Location, StringComparison.OrdinalIgnoreCase)) continue;
                        ShowWindowAsync(process.MainWindowHandle, 9);
                        SetForegroundWindow(process.MainWindowHandle);
                    }
                    catch { }
                }
                InstanceMutex.Dispose();
                return;
            }
            try
            {
                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                RunWindow(Array.IndexOf(args, "--smoke-test") >= 0);
            }
            catch (Exception e)
            {
                MessageBox.Show("桌面应用启动失败：\n" + e.Message + "\n\n请确认 desktop/runtime 文件完整、WebView2 Runtime 已安装。", "HSArriver Turbo", MessageBoxButtons.OK, MessageBoxIcon.Error);
                Environment.ExitCode = 1;
            }
            finally
            {
                try { InstanceMutex.ReleaseMutex(); } catch { }
                InstanceMutex.Dispose();
            }
        }

        // Resolve the WebView2 assemblies after installing the resolver in Main.
        private static void RunWindow(bool smoke)
        {
            Application.Run(new MainWindow(Root, smoke));
        }
    }
}
