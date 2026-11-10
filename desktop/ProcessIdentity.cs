using System;
using System.Diagnostics;
using System.Runtime.InteropServices;

namespace HSArriver.Desktop
{
    internal static class ProcessIdentity
    {
        [StructLayout(LayoutKind.Sequential)]
        private struct BasicInformation
        {
            internal IntPtr Reserved1;
            internal IntPtr Peb;
            internal IntPtr Reserved2;
            internal IntPtr Reserved3;
            internal IntPtr Pid;
            internal IntPtr ParentPid;
        }
        [DllImport("ntdll.dll")]
        private static extern int NtQueryInformationProcess(IntPtr handle, int informationClass, out BasicInformation information, int size, out int returned);

        // Windows venv's python.exe is a redirector; the Python interpreter can
        // be a child with a different PID. Verify ancestry, never trust the PID
        // provided by a localhost server alone.
        internal static bool IsLaunchedInterpreter(int pid, Process launcher)
        {
            if (pid == launcher.Id) return true;
            try
            {
                int current = pid;
                for (int depth = 0; depth < 4; depth++)
                {
                    using (Process process = Process.GetProcessById(current))
                    {
                        if (process.HasExited) return false;
                        BasicInformation information;
                        int returned;
                        if (NtQueryInformationProcess(process.Handle, 0, out information, Marshal.SizeOf(typeof(BasicInformation)), out returned) != 0) return false;
                        current = information.ParentPid.ToInt32();
                    }
                    if (current == launcher.Id && !launcher.HasExited) return true;
                    if (current <= 0) return false;
                }
            }
            catch { }
            return false;
        }
    }
}
