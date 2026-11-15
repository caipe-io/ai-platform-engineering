"""Real kernel enforcement tests. Run in the CLI image as its non-root user.

python /tests/claude_isolation_linux.py
Requires Landlock ABI 6; missing enforcement is a failure, never a skip.
Only disposable fixtures are accessed, including in a live-worker smoke test.
"""

from __future__ import annotations

import json
import os
import signal
import socket
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

LAUNCHER = os.environ.get("CLAUDE_SANDBOX_TEST_LAUNCHER", "/usr/local/bin/caipe-claude-sandbox")


class IsolationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.root = tempfile.TemporaryDirectory(prefix="claude-isolation-test-")
        self.addCleanup(self.root.cleanup)
        # Kubernetes fsGroup volumes propagate setgid to private workspaces.
        os.chmod(self.root.name, 0o2700)
        self.a, self.b = (Path(self.root.name) / name for name in ("a", "b"))
        for workspace in (self.a, self.b):
            workspace.mkdir(mode=0o700)
            (workspace / "capability").write_text("disposable-test-capability")

    def command(self, workspace: Path, code: str, *ports: int) -> list[str]:
        args = [LAUNCHER, "--workspace", str(workspace)]
        for port in ports:
            args += ["--connect-port", str(port)]
        return args + ["--", sys.executable, "-c", code]

    def run_code(self, code: str, *ports: int, **kwargs: object) -> dict:
        result = subprocess.run(self.command(self.a, code, *ports), capture_output=True, text=True,
                                timeout=15, **kwargs)
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads(result.stdout)

    def test_preflight_and_real_cli(self) -> None:
        result = subprocess.run([LAUNCHER, "--check"], capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        args = [LAUNCHER, "--workspace", str(self.a), "--", "claude", "--version"]
        result = subprocess.run(args, capture_output=True, text=True, timeout=20,
                                env={"PATH": os.environ["PATH"], "HOME": str(self.a), "CLAUDE_CONFIG_DIR": str(self.a / ".claude")})
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("Claude Code", result.stdout)

    def test_files_symlinks_proc_and_inherited_descriptors(self) -> None:
        (self.a / "escape").symlink_to(self.b / "capability")
        with (self.b / "capability").open() as inherited:
            result = self.run_code(f'''
import errno, os, json
from pathlib import Path
result = {{}}
Path("own-file").write_text("ok")
result["own"] = Path("own-file").read_text()
for name, path in {{"sibling": {str(self.b / 'capability')!r}, "symlink": "escape",
                   "parent_environment": "/proc/{os.getpid()}/environ", "parent_memory": "/proc/{os.getpid()}/mem"}}.items():
    try: Path(path).read_bytes(); result[name] = "EXPOSED"
    except PermissionError: result[name] = "denied"
try: os.read({inherited.fileno()}, 100); result["inherited_fd"] = "EXPOSED"
except OSError: result["inherited_fd"] = "closed"
try: os.link({str(self.b / 'capability')!r}, "hardlink"); result["hardlink"] = "EXPOSED"
except OSError as error:
    if error.errno not in (errno.EACCES, errno.EPERM, errno.EXDEV): raise
    result["hardlink"] = "denied"
print(json.dumps(result))
''', pass_fds=(inherited.fileno(),))
        self.assertEqual(result, {"own": "ok", "sibling": "denied", "symlink": "denied",
                                  "parent_environment": "denied", "parent_memory": "denied", "inherited_fd": "closed",
                                  "hardlink": "denied"})

    def test_network_and_process_restrictions(self) -> None:
        with socket.socket() as allowed, socket.socket() as denied:
            allowed.bind(("127.0.0.1", 0))
            allowed.listen()
            denied.bind(("127.0.0.1", 0))
            denied.listen()
            permitted_port, denied_port = allowed.getsockname()[1], denied.getsockname()[1]
            result = self.run_code(f'''
import ctypes, json, os, socket
r = {{}}
for label, action in [
    ("allowed", lambda: socket.create_connection(("127.0.0.1", {permitted_port}))),
    ("other_port", lambda: socket.create_connection(("127.0.0.1", {denied_port}))),
    ("bind", lambda: socket.socket().bind(("127.0.0.1", 0))),
    ("udp", lambda: socket.socket(socket.AF_INET, socket.SOCK_DGRAM)),
    ("unix", lambda: socket.socket(socket.AF_UNIX)),
    ("sctp", lambda: socket.socket(socket.AF_INET, socket.SOCK_STREAM, 132)),
    ("signal_parent", lambda: os.kill({os.getpid()}, 0)),
    ("escape_group", os.setsid),
]:
    try:
        obj = action()
        if hasattr(obj, "close"): obj.close()
        r[label] = "allowed"
    except PermissionError: r[label] = "denied"
c = ctypes.CDLL(None, use_errno=True)
r["ptrace"] = "denied" if c.ptrace(0, 0, 0, 0) == -1 and ctypes.get_errno() == 1 else "EXPOSED"
r["process_vm"] = "denied" if c.process_vm_readv(os.getpid(), 0, 0, 0, 0, 0) == -1 and ctypes.get_errno() == 1 else "EXPOSED"
print(json.dumps(r))
''', permitted_port)
        self.assertEqual(result, {"allowed": "allowed", **{k: "denied" for k in
                         ["other_port", "bind", "udp", "unix", "sctp", "signal_parent", "escape_group", "ptrace", "process_vm"]}})

    def test_concurrent_sessions_and_descendants(self) -> None:
        children = []
        try:
            for own, other in ((self.a, self.b), (self.b, self.a)):
                code = f'''
import json, subprocess, sys, time
from pathlib import Path
probe = "from pathlib import Path; Path({str(other / 'capability')!r}).read_text()"
child = subprocess.run([sys.executable, "-c", probe], capture_output=True)
Path("ready").touch()
while not Path("finish").exists(): time.sleep(.01)
print(json.dumps({{"own": Path("capability").read_text(), "child_denied": b"PermissionError" in child.stderr}}))
'''
                children.append(subprocess.Popen(self.command(own, code), stdout=subprocess.PIPE,
                                                 stderr=subprocess.PIPE, text=True, start_new_session=True))
            deadline = time.monotonic() + 10
            while not all((p / "ready").exists() for p in (self.a, self.b)):
                self.assertTrue(time.monotonic() < deadline, "sandbox children did not become ready")
                time.sleep(.01)
            for p in (self.a, self.b):
                (p / "finish").touch()
            for child in children:
                out, err = child.communicate(timeout=10)
                self.assertEqual(child.returncode, 0, err)
                self.assertEqual(json.loads(out), {"own": "disposable-test-capability", "child_denied": True})
        finally:
            for child in children:
                if child.poll() is None:
                    os.killpg(child.pid, signal.SIGKILL)
                child.wait()

    def test_cancellation_drains_descendants(self) -> None:
        code = '''
import subprocess, sys, time
from pathlib import Path
p = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"])
Path("child-pid").write_text(str(p.pid))
time.sleep(60)
'''
        child = subprocess.Popen(self.command(self.a, code), start_new_session=True,
                                 stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        try:
            deadline = time.monotonic() + 10
            while not (self.a / "child-pid").exists():
                self.assertTrue(time.monotonic() < deadline, "child did not start")
                time.sleep(.01)
            descendant = int((self.a / "child-pid").read_text())
            os.killpg(child.pid, signal.SIGTERM)
            child.wait(timeout=5)
            deadline = time.monotonic() + 5
            while True:
                try:
                    os.kill(descendant, 0)
                except ProcessLookupError:
                    break
                self.assertTrue(time.monotonic() < deadline, "descendant was not reaped by container init")
                time.sleep(.01)
        finally:
            try:
                os.killpg(child.pid, signal.SIGKILL)
            except ProcessLookupError:
                # Successful cancellation already removed the process group.
                pass
            child.wait()
            child.stderr.close()

    def test_rejects_symlink_workspace(self) -> None:
        alias = Path(self.root.name) / "alias"
        alias.symlink_to(self.a)
        result = subprocess.run(self.command(alias, "print('UNSAFE')"), capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 125)
        self.assertNotIn("UNSAFE", result.stdout)


if __name__ == "__main__":
    unittest.main(verbosity=2)
