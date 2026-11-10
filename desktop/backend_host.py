"""Start the existing backend for the desktop app, with an event-based handshake.

Only starts the control service: desktop startup never restores a battle schedule
or opens an external browser. Automation still requires an explicit UI action.
"""

import argparse
import faulthandler
import http.client
import json
import os
import sys
import struct
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PREFIX = "HS_DESKTOP "


def emit(kind, **data):
    print(PREFIX + json.dumps({"kind": kind, **data}, ensure_ascii=False), flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check-startup", action="store_true")
    args = parser.parse_args()
    os.chdir(ROOT)
    sys.path.insert(0, str(ROOT))
    if sys.version_info[:2] != (3, 12) or struct.calcsize("P") != 8:
        raise RuntimeError("桌面后端需要 Python 3.12（64 位），请检查 log/env.json")
    emit("progress", message="正在加载后端模块…")
    if args.check_startup:
        faulthandler.dump_traceback_later(25, exit=True)
    import web_ui

    original_write = web_ui._write_port_file

    def ready(port):
        original_write(port)
        emit("ready", url=f"http://127.0.0.1:{port}", pid=os.getpid(),
             root=str(ROOT), is_admin=web_ui.IS_ADMIN,
             token=web_ui._SERVE_TOKEN)
        if args.check_startup:
            # This is loopback HTTP, not HTTPS. Avoid urllib's default HTTPS
            # handler loading the Windows certificate store for a local probe.
            connection = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
            connection.request("GET", "/api/status")
            response = connection.getresponse()
            state = json.loads(response.read().decode("utf-8"))
            connection.close()
            emit("checked", phase=state.get("phase"), running=state.get("running"))
            faulthandler.cancel_dump_traceback_later()
            web_ui._clear_port_file()
            os._exit(0)

    web_ui._write_port_file = ready
    emit("progress", message="正在启动本地控制服务…")
    web_ui.main(desktop=True)


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        emit("error", message=f"{type(exc).__name__}: {exc}")
        raise
