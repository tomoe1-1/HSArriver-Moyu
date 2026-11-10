"""Desktop startup contracts. No UAC, actual processes, or game operations."""

import json
import sys
import types
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

import desktop.backend_host as host
import web_ui

ROOT = Path(__file__).resolve().parent.parent


class BackendHostTests(unittest.TestCase):
    def test_host_starts_the_backend_in_safe_desktop_mode(self):
        backend = types.SimpleNamespace(
            main=Mock(), _write_port_file=Mock(), IS_ADMIN=False,
            _SERVE_TOKEN="test-token",
        )
        with (
            patch.object(sys, "argv", ["backend_host.py"]),
            patch.dict(sys.modules, {"web_ui": backend}),
            patch.object(sys, "path", list(sys.path)),
            patch.object(host.os, "chdir"),
            patch.object(host, "emit"),
        ):
            host.main()
        backend.main.assert_called_once_with(desktop=True)

    def test_ready_handshake_keeps_root_pid_and_loopback(self):
        written = Mock()
        messages = Mock()
        backend = types.SimpleNamespace(main=Mock(), _write_port_file=written,
                                        IS_ADMIN=False, _SERVE_TOKEN="test-token")
        with (
            patch.object(sys, "argv", ["backend_host.py"]),
            patch.dict(sys.modules, {"web_ui": backend}),
            patch.object(sys, "path", list(sys.path)),
            patch.object(host.os, "chdir"),
            patch.object(host, "emit", messages),
        ):
            host.main()
            backend._write_port_file(8767)
        written.assert_called_once_with(8767)
        ready = messages.call_args.kwargs
        self.assertEqual(ready["url"], "http://127.0.0.1:8767")
        self.assertEqual(ready["root"], str(ROOT))
        self.assertEqual(ready["pid"], host.os.getpid())

    def test_rejects_incompatible_python(self):
        with (
            patch.object(sys, "argv", ["backend_host.py"]),
            patch.object(sys, "version_info", (3, 13, 0)),
            patch.object(sys, "path", list(sys.path)),
            patch.object(host.os, "chdir"),
        ):
            with self.assertRaisesRegex(RuntimeError, "Python 3.12"):
                host.main()

    def test_rejects_32bit_python(self):
        with (
            patch.object(sys, "argv", ["backend_host.py"]),
            patch.object(host.struct, "calcsize", return_value=4),
            patch.object(sys, "path", list(sys.path)),
            patch.object(host.os, "chdir"),
        ):
            with self.assertRaisesRegex(RuntimeError, "64 位"):
                host.main()


class DesktopBackendModeTests(unittest.TestCase):
    def test_desktop_does_not_resume_schedule_or_steal_game_focus(self):
        server = Mock()
        threads = []

        def make_thread(*args, **kwargs):
            threads.append(kwargs.get("target"))
            return Mock()

        with (
            patch.object(web_ui, "_ControlServer", return_value=server),
            patch.object(web_ui.threading, "Thread", side_effect=make_thread),
            patch.object(web_ui.threading, "Timer") as timer,
            patch.object(web_ui, "_boot_resume_schedule") as resume,
            patch.object(web_ui, "_register_hotkey"),
            patch.object(web_ui, "_bind_watchdog_restarter"),
            patch.object(web_ui, "_apply_constants"),
            patch.object(web_ui, "load_config", return_value={}),
            patch.object(web_ui, "start_selfcheck_async"),
            patch.object(web_ui.update_check, "start_periodic"),
            patch.object(web_ui, "_write_port_file"),
            patch.object(web_ui, "_clear_port_file"),
            patch.object(web_ui.time, "sleep", side_effect=KeyboardInterrupt),
            patch("builtins.print"),
        ):
            web_ui.main(desktop=True)
        resume.assert_not_called()
        timer.assert_not_called()
        self.assertNotIn(web_ui._hearthstone_foreground_guard, threads)

    def test_native_launcher_uses_an_event_not_a_readiness_poll(self):
        source = (ROOT / "desktop" / "BackendSession.cs").read_text(encoding="utf-8")
        self.assertIn("TaskCompletionSource<BackendReady>", source)
        self.assertIn("OutputDataReceived", source)
        self.assertIn("ProcessIdentity.IsLaunchedInterpreter", source)
        self.assertNotIn("Thread.Sleep", source)

    def test_no_automatic_uac_or_remote_control_server(self):
        manifest = (ROOT / "desktop" / "app.manifest").read_text(encoding="utf-8")
        self.assertIn('level="asInvoker"', manifest)
        source = (ROOT / "desktop" / "BackendSession.cs").read_text(encoding="utf-8")
        self.assertIn('uri.Host == "127.0.0.1"', source)
        self.assertIn("request.AllowAutoRedirect = false", source)

    def test_stops_only_owned_backend_and_its_verified_interpreter(self):
        source = (ROOT / "desktop" / "BackendSession.cs").read_text(encoding="utf-8")
        self.assertIn("if (!Owned) throw", source)
        self.assertNotIn("GetProcessesByName", source)
        ui = (ROOT / "desktop" / "MainWindow.cs").read_text(encoding="utf-8")
        self.assertIn('ConfirmStop("停止后端")', ui)
        self.assertIn('ConfirmStop("退出软件")', ui)

    def test_admin_frontend_does_not_silently_reuse_unelevated_backend(self):
        ui = (ROOT / "desktop" / "MainWindow.cs").read_text(encoding="utf-8")
        self.assertIn("IsAdmin() && !state.IsAdmin", ui)
        self.assertIn("await backend.StopConfirmedExistingAsync()", ui)
        self.assertIn('action == "request-admin"', ui)
        self.assertIn("前端已是管理员", ui)

    def test_permission_repair_never_force_kills_external_process(self):
        source = (ROOT / "desktop" / "BackendSession.cs").read_text(encoding="utf-8")
        repair = source.split("internal async Task StopConfirmedExistingAsync()", 1)[1].split("internal async Task StopOwnedAsync()", 1)[0]
        self.assertNotIn(".Kill()", repair)
        self.assertIn('"/api/serve/stop"', repair)
        self.assertIn('"project_root"', repair)
        self.assertIn("未强制结束", repair)

    def test_frontend_and_backend_permissions_are_reported_separately(self):
        ui = (ROOT / "desktop" / "MainWindow.cs").read_text(encoding="utf-8")
        self.assertIn("frontend_admin = IsAdmin()", ui)
        self.assertIn("backend_admin = backend.Ready", ui)
        js = (ROOT / "web" / "workbench.js").read_text(encoding="utf-8")
        self.assertIn('desktopMessage("request-admin")', js)
        self.assertIn("游戏点击取决于后端权限", js)


if __name__ == "__main__":
    unittest.main()
