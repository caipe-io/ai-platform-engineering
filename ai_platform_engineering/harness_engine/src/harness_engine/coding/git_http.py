"""Broker Git Smart HTTP without exposing provider credentials to the sandbox."""

from __future__ import annotations

import asyncio
import base64
import fnmatch
import hashlib
import hmac
import json
import os
import re
import secrets
import shlex
import sys
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Any
from urllib.parse import quote, urlsplit
from uuid import uuid4

import httpx

from harness_engine.coding.admission import CodingAdmissionError, RunFence
from harness_engine.coding.authorization import AuthorizedRunCredentials
from harness_engine.coding.config import GitPolicy, service_url
from harness_engine.coding.resources import PlatformResourceBroker

_REPOSITORY = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")
_OID = re.compile(r"^[a-f0-9]{40}$")
_ZERO = "0" * 40
_LIMITED_GIT = """import os,resource,sys
size=int(sys.argv[1]);cpu=int(sys.argv[2])
resource.setrlimit(resource.RLIMIT_FSIZE,(size,size))
if sys.platform=='linux':
 cap=768*1024*1024;hard=resource.getrlimit(resource.RLIMIT_AS)[1]
 cap=min(cap,hard) if hard!=resource.RLIM_INFINITY else cap
 resource.setrlimit(resource.RLIMIT_AS,(cap,cap))
resource.setrlimit(resource.RLIMIT_CPU,(cpu,cpu))
resource.setrlimit(resource.RLIMIT_NOFILE,(128,128))
os.execvpe('git',['git',*sys.argv[3:]],os.environ)
"""


def repository_name(value: str) -> str:
    if not _REPOSITORY.fullmatch(value) or ".." in value or value.endswith(".git"):
        raise CodingAdmissionError("The Git repository identity is invalid")
    return value.lower()


def parse_receive_pack(body: bytes) -> tuple[list[tuple[str, str, str]], bytes]:
    """Bound command framing before any upstream Git write or pack decoding."""
    offset, commands = 0, []
    while True:
        if offset + 4 > len(body):
            raise CodingAdmissionError("The Git reference command stream is incomplete")
        try:
            length = int(body[offset : offset + 4], 16)
        except ValueError:
            raise CodingAdmissionError("The Git reference command framing is invalid") from None
        offset += 4
        if length == 0:
            break
        if length < 4 or length > 4096 or offset + length - 4 > len(body) or len(commands) >= 16:
            raise CodingAdmissionError("The Git reference command exceeds its supported bounds")
        raw = body[offset : offset + length - 4]
        offset += length - 4
        line, separator, capabilities = raw.partition(b"\x00")
        if separator and commands:
            raise CodingAdmissionError("Only the first Git reference command may declare capabilities")
        if b"push-options" in capabilities.split():
            raise CodingAdmissionError("Git push options are unsupported")
        try:
            old, new, ref = line.decode("ascii").strip().split(" ")
        except (ValueError, UnicodeError):
            raise CodingAdmissionError("The Git reference update is invalid") from None
        if not _OID.fullmatch(old) or not _OID.fullmatch(new) or not ref.startswith("refs/heads/"):
            raise CodingAdmissionError("Only SHA-1 branch updates are supported")
        if any(item[2] == ref for item in commands):
            raise CodingAdmissionError("A Git reference may be updated only once per operation")
        commands.append((old, new, ref))
    pack = body[offset:]
    if not commands or (any(new != _ZERO for _, new, _ in commands) and not pack.startswith(b"PACK")):
        raise CodingAdmissionError("The Git write request has no valid pack")
    return commands, pack


def _git_success(body: bytes) -> bytes:
    commands, _ = parse_receive_pack(body)

    def packet(value: bytes) -> bytes:
        return f"{len(value) + 4:04x}".encode() + value

    report = (
        packet(b"unpack ok\n") + b"".join(packet(("ok " + ref + "\n").encode()) for _, _, ref in commands) + b"0000"
    )
    first_length = int(body[:4], 16)
    capabilities = body[4:first_length].partition(b"\x00")[2].split()
    if b"side-band-64k" in capabilities:
        return packet(b"\x01" + report) + b"0000"
    return report


class GitBroker:
    def __init__(self, policy: GitPolicy, fence: RunFence, credentials: AuthorizedRunCredentials) -> None:
        self.policy, self.fence, self.credentials = policy, fence, credentials

    async def _audit(self, repository: str, action: str, outcome: str, *, refs: list[str] | None = None) -> None:
        # Existing audit service stores no pack bodies, OAuth credentials, opaque
        # broker capabilities, or repository file contents in this record.
        event = {
            "type": "agent_operation",
            "component": "harness-engine",
            "action": "git." + action,
            "outcome": outcome,
            "actor_ref": self.fence.context.binding.owner_subject,
            "resource_ref": "github:" + repository,
            "correlation_id": self.fence.context.turn.run_id,
            "refs": refs or [],
        }
        async with httpx.AsyncClient(timeout=5, follow_redirects=False) as client:
            response = await client.post(
                service_url(self.policy.audit_service_url) + "/v1/audit/events", json={"events": [event]}
            )
            if response.status_code != 202:
                raise CodingAdmissionError("The Git audit record could not be accepted")

    async def _selected(self, *, write: bool) -> None:
        await self.fence.require()
        context = self.fence.context
        agent = await asyncio.to_thread(self.fence.db.dynamic_agents.find_one, {"_id": context.binding.agent_id})
        choices = (agent or {}).get("allowed_tools", {})
        saved = {binding.tool_id for binding in context.blueprint.tools.bindings}
        candidates = self.policy.write_tool_ids if write else self.policy.read_tool_ids
        for identifier in candidates:
            for server_id, selected in choices.items():
                prefix = server_id + "."
                if not identifier.startswith(prefix):
                    continue
                tool = identifier[len(prefix) :]
                if selected is not True and (not isinstance(selected, list) or tool not in selected):
                    continue
                if identifier not in saved and server_id + ".*" not in saved:
                    continue
                server = await asyncio.to_thread(self.fence.db.mcp_servers.find_one, {"_id": server_id})
                if server and server.get("enabled", True) is True:
                    await self.credentials.authorize_resource("tool", server_id + "/" + tool, "call")
                    return
        raise CodingAdmissionError("The agent's current selected Git tools do not authorize this action")

    async def _requires_review(self, *, write: bool) -> bool:
        policy = self.fence.context.blueprint.tools.approval_policy
        if policy == "always" or policy == "sensitive_only" and write:
            return True
        agent = await asyncio.to_thread(
            self.fence.db.dynamic_agents.find_one, {"_id": self.fence.context.binding.agent_id}
        )
        for identifier in self.policy.write_tool_ids if write else self.policy.read_tool_ids:
            for server, rules in (agent or {}).get("interrupt_on", {}).items():
                if identifier.startswith(server + "."):
                    tool = identifier[len(server) + 1 :]
                    if rules.get(tool, rules.get("*", False)):
                        return True
        return False

    async def _provider_token(self) -> str:
        bearer = await self.credentials.token()
        async with httpx.AsyncClient(timeout=10, follow_redirects=False) as client:
            response = await client.post(
                service_url(self.credentials.settings.coding_platform_url) + "/api/credentials/exchange",
                headers={
                    "Authorization": "Bearer " + bearer,
                    "x-caipe-credential-caller": "internal_service",
                    "x-caipe-credential-audience": self.policy.credential_audience,
                },
                json={"provider": "github", "intended_use": "provider_exchange"},
            )
        if response.status_code != 200:
            raise CodingAdmissionError("Connect an authorized GitHub account before using sandbox Git")
        data = response.json()
        token = data.get("data", data).get("access_token")
        if not isinstance(token, str) or not token:
            raise CodingAdmissionError("The GitHub credential exchange returned no usable credential")
        return token

    async def _github(self, path: str, token: str, *, allow_missing: bool = False) -> dict[str, Any] | list[Any] | None:
        async with httpx.AsyncClient(timeout=10, follow_redirects=False) as client:
            async with client.stream(
                "GET",
                "https://api.github.com" + path,
                headers={
                    "Authorization": "Bearer " + token,
                    "Accept": "application/vnd.github+json",
                    "X-GitHub-Api-Version": "2022-11-28",
                },
            ) as response:
                if response.status_code == 404 and allow_missing:
                    return None
                if response.status_code != 200:
                    raise CodingAdmissionError("GitHub rejected the repository policy check")
                data = bytearray()
                async for chunk in response.aiter_bytes():
                    data.extend(chunk)
                    if len(data) > 1024 * 1024:
                        raise CodingAdmissionError("The GitHub policy response exceeds its supported size")
        try:
            value = json.loads(data)
            if not isinstance(value, (dict, list)):
                raise ValueError
            return value
        except ValueError:
            raise CodingAdmissionError("The GitHub policy response is invalid") from None

    async def authorize_repository(self, repository: str, *, write: bool) -> tuple[str, dict[str, Any]]:
        repository = repository_name(repository)
        if not any(fnmatch.fnmatchcase(repository, pattern) for pattern in self.policy.repositories):
            raise CodingAdmissionError("The operator Git policy does not admit this repository")
        await self._selected(write=write)
        token = await self._provider_token()
        info = await self._github("/repos/" + repository, token)
        if not isinstance(info, dict) or info.get("full_name", "").lower() != repository:
            raise CodingAdmissionError("GitHub returned a different repository identity")
        permissions = info.get("permissions", {})
        if permissions.get("push" if write else "pull") is not True:
            raise CodingAdmissionError("The connected GitHub account lacks the required repository permission")
        await self.fence.require()
        return token, info

    async def mint(self, repository: str, run_capability: str) -> dict[str, str]:
        await PlatformResourceBroker.authorize(self.fence, run_capability)
        repository = repository_name(repository)
        await self.authorize_repository(repository, write=False)
        write = False
        if self.policy.write_tool_ids:
            try:
                await self.authorize_repository(repository, write=True)
                write = True
            except CodingAdmissionError:
                pass  # A read capability never acquires write rights by fallback.
        if await self._requires_review(write=False):
            await PlatformResourceBroker.approve_git(
                self.fence,
                repository=repository,
                refs=[],
                pack_sha256=hashlib.sha256(repository.encode()).hexdigest(),
                action="fetch",
            )
        capability = secrets.token_urlsafe(32)
        value = {"hash": hashlib.sha256(capability.encode()).hexdigest(), "repository": repository, "write": write}
        result = await asyncio.to_thread(
            self.fence.db.harness_runs.update_one,
            {
                "run_id": self.fence.context.turn.run_id,
                "_producer_id": self.fence.context.producer_token,
                "_coding_capability_hash": hashlib.sha256(run_capability.encode()).hexdigest(),
                "cancellation_requested": False,
                "_coding_resources_closed": {"$ne": True},
                "_coding_git_capabilities.63": {"$exists": False},
            },
            {"$push": {"_coding_git_capabilities": value}},
        )
        if result.modified_count != 1:
            raise CodingAdmissionError("The admitted Git capability budget is exhausted")
        await self._audit(repository, "admit", "allow")
        return {"username": "caipe", "capability": capability}

    async def validate_capability(self, repository: str, capability: str, *, write: bool) -> None:
        run, _ = await self.fence.require()
        target = hashlib.sha256(capability.encode()).hexdigest()
        if run.get("_coding_resources_closed") or not 32 <= len(capability) <= 256 or not any(
            entry.get("repository") == repository
            and hmac.compare_digest(entry.get("hash", ""), target)
            and (not write or entry.get("write") is True)
            for entry in run.get("_coding_git_capabilities", [])
        ):
            raise CodingAdmissionError("The Git capability does not admit this repository action")

    async def _reserve_dispatch(self, repository: str, capability: str, write: bool, identifier: str) -> None:
        context = self.fence.context
        entry = {"repository": repository, "hash": hashlib.sha256(capability.encode()).hexdigest()}
        if write:
            entry["write"] = True
        result = await asyncio.to_thread(
            self.fence.db.harness_runs.update_one,
            {
                "run_id": context.turn.run_id,
                "binding_id": context.binding.binding_id,
                "owner_subject": context.binding.owner_subject,
                "_producer_id": context.producer_token,
                "_producer_expires_at": {"$gt": datetime.now(timezone.utc)},
                "status": "running",
                "pending_interrupt_id": None,
                "cancellation_requested": False,
                "_coding_resources_closed": {"$ne": True},
                "_coding_capability_hash": {"$exists": True},
                "_coding_git_capabilities": {"$elemMatch": entry},
                f"_coding_git_dispatches.{identifier}": {"$exists": False},
                "$or": [
                    {"_coding_git_operation_count": {"$exists": False}},
                    {"_coding_git_operation_count": {"$lt": self.policy.max_operations}},
                ],
            },
            {
                "$inc": {"_coding_git_operation_count": 1},
                "$set": {f"_coding_git_dispatches.{identifier}": "executing"},
            },
        )
        if result.modified_count != 1:
            raise CodingAdmissionError("The Git operation was revoked or its admitted budget is exhausted")

    async def _complete_dispatch(self, identifier: str) -> None:
        await asyncio.to_thread(
            self.fence.db.harness_tool_requests.update_one,
            {
                "_id": identifier,
                "git_producer": self.fence.context.producer_token,
                "git_phase": "executing",
            },
            {"$set": {"git_phase": "completed"}},
        )
        await asyncio.to_thread(
            self.fence.db.harness_runs.update_one,
            {
                "run_id": self.fence.context.turn.run_id,
                "_producer_id": self.fence.context.producer_token,
                f"_coding_git_dispatches.{identifier}": "executing",
            },
            {"$set": {f"_coding_git_dispatches.{identifier}": "completed"}},
        )

    async def _run_git(self, directory: Path, *args: str, token: str, data: bytes | None = None) -> tuple[int, bytes]:
        auth = base64.b64encode(("x-access-token:" + token).encode()).decode()
        environment = {
            "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
            "HOME": str(directory),
            "GIT_TERMINAL_PROMPT": "0",
            "GIT_CONFIG_NOSYSTEM": "1",
            "GIT_CONFIG_COUNT": "3",
            "GIT_CONFIG_KEY_0": "http.extraHeader",
            "GIT_CONFIG_VALUE_0": "Authorization: Basic " + auth,
            "GIT_CONFIG_KEY_1": "http.followRedirects",
            "GIT_CONFIG_VALUE_1": "false",
            "GIT_CONFIG_KEY_2": "protocol.file.allow",
            "GIT_CONFIG_VALUE_2": "never",
        }
        process = await asyncio.create_subprocess_exec(
            sys.executable,
            "-c",
            _LIMITED_GIT,
            str(self.policy.max_repository_bytes),
            str(int(self.policy.timeout_seconds)),
            *args,
            cwd=directory,
            env=environment,
            stdin=asyncio.subprocess.PIPE if data is not None else asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
        )
        try:
            async with asyncio.timeout(self.policy.timeout_seconds):
                output, _ = await process.communicate(data)
            if len(output) > 1024 * 1024:
                raise CodingAdmissionError("The Git verifier output exceeds its supported size")
            return process.returncode or 0, output
        finally:
            if process.returncode is None:
                process.kill()
                await process.wait()

    async def validate_write(self, repository: str, body: bytes, token: str, info: dict[str, Any]) -> list[str]:
        commands, pack = parse_receive_pack(body)
        refs = []
        for old, new, ref in commands:
            if (
                not any(ref.startswith(prefix) for prefix in self.policy.ref_prefixes)
                or ".." in ref
                or "@{" in ref
                or any(char in ref for char in " ~^:?*[\\")
                or ref.endswith(("/", ".", ".lock"))
            ):
                raise CodingAdmissionError("The Git write reference is outside the approved branch policy")
            branch = ref.removeprefix("refs/heads/")
            if branch == info.get("default_branch") and not self.policy.allow_default_branch_write:
                raise CodingAdmissionError("Direct writes to the default branch are not admitted")
            branch_info = await self._github(
                f"/repos/{repository}/branches/{quote(branch, safe='')}", allow_missing=True, token=token
            )
            if (
                isinstance(branch_info, dict)
                and branch_info.get("protected")
                and not self.policy.allow_protected_branch_write
            ):
                raise CodingAdmissionError("Writes to protected branches are not admitted")
            # Rulesets can protect a branch that does not exist yet. GitHub is
            # still the final policy enforcer; this admission check narrows it.
            rules = await self._github(f"/repos/{repository}/rules/branches/{quote(branch, safe='')}", token)
            if rules and not self.policy.allow_protected_branch_write:
                raise CodingAdmissionError("The repository ruleset protects this write reference")
            if new == _ZERO and not self.policy.allow_branch_delete:
                raise CodingAdmissionError("Deleting branches is not admitted")
            refs.append(ref)
        with TemporaryDirectory(prefix="caipe-git-") as path:
            directory = Path(path)
            for args in (
                ("init", "--bare", "--quiet", "."),
                (
                    "fetch",
                    "--quiet",
                    "--no-tags",
                    "https://github.com/" + repository + ".git",
                    "+refs/heads/*:refs/remotes/origin/*",
                ),
            ):
                code, _ = await self._run_git(directory, *args, token=token)
                if code:
                    raise CodingAdmissionError("The repository exceeded the bounded Git verification contract")
            if pack:
                code, _ = await self._run_git(
                    directory,
                    "index-pack",
                    "--stdin",
                    "--fix-thin",
                    "--strict",
                    "--max-input-size=" + str(self.policy.max_pack_bytes),
                    token=token,
                    data=pack,
                )
                if code:
                    raise CodingAdmissionError("The Git pack failed bounded integrity verification")
            for old, new, ref in commands:
                if new == _ZERO:
                    continue
                code, kind = await self._run_git(directory, "cat-file", "-t", new, token=token)
                if code or kind.strip() != b"commit":
                    raise CodingAdmissionError("A branch update must reference a verified commit")
                if old != _ZERO:
                    code, _ = await self._run_git(directory, "merge-base", "--is-ancestor", old, new, token=token)
                    if code:
                        raise CodingAdmissionError("Force pushes or unrelated branch rewrites are not admitted")
        await self.fence.require()
        return refs

    async def _write_matches(self, repository: str, body: bytes, token: str) -> bool:
        commands, _ = parse_receive_pack(body)
        for _, expected, ref in commands:
            actual = await self._github(
                f"/repos/{repository}/git/ref/{quote(ref.removeprefix('refs/'), safe='')}",
                allow_missing=True,
                token=token,
            )
            if expected == _ZERO:
                if actual is not None:
                    return False
            elif not isinstance(actual, dict) or actual.get("object", {}).get("sha") != expected:
                return False
        return True

    @asynccontextmanager
    async def proxy(
        self,
        repository: str,
        capability: str,
        *,
        method: str,
        operation: str,
        service: str | None,
        body: bytes,
        content_type: str,
    ) -> AsyncIterator[httpx.Response]:
        repository = repository_name(repository)
        if operation == "info/refs" and method == "GET" and service in {"git-upload-pack", "git-receive-pack"}:
            write = service == "git-receive-pack"
        elif method == "POST" and operation in {"git-upload-pack", "git-receive-pack"} and service is None:
            write = operation == "git-receive-pack"
            if content_type.split(";", 1)[0] != "application/x-" + operation + "-request":
                raise CodingAdmissionError("The Git operation content type is invalid")
        else:
            raise CodingAdmissionError("Only Git Smart HTTP fetch and push operations are admitted")
        await self.validate_capability(repository, capability, write=write)
        token, info = await self.authorize_repository(repository, write=write)
        call_id: str | None = None
        refs = await self.validate_write(repository, body, token, info) if write and method == "POST" else []
        if write and method == "POST":
            call_id = await PlatformResourceBroker.approve_git(
                self.fence,
                repository=repository,
                refs=refs,
                pack_sha256=hashlib.sha256(body).hexdigest(),
                require_review=await self._requires_review(write=True),
            )
            # A durable approval never doubles as an unlimited retry permission.
            # The existing resource request owns exactly one external dispatch.
            record = await asyncio.to_thread(self.fence.db.harness_tool_requests.find_one, {"_id": call_id})
            if record and record.get("git_phase") is not None:
                if await self._write_matches(repository, body, token):
                    await self._audit(repository, "write", "reconciled", refs=refs)
                    await self._complete_dispatch(call_id)
                    yield httpx.Response(
                        200,
                        content=_git_success(body),
                        headers={"Content-Type": "application/x-git-receive-pack-result"},
                    )
                    return
                raise CodingAdmissionError("The accepted Git write has an uncertain outcome and was not resent")
            await self.fence.require()
            claimed = await asyncio.to_thread(
                self.fence.db.harness_tool_requests.update_one,
                {
                    "_id": call_id,
                    "run_id": self.fence.context.turn.run_id,
                    "status": "complete",
                    "result.approved": True,
                    "git_phase": {"$exists": False},
                },
                {"$set": {"git_phase": "executing", "git_producer": self.fence.context.producer_token}},
            )
            if claimed.modified_count != 1:
                raise CodingAdmissionError("The accepted Git write is already dispatched and was not resent")
        await self._audit(repository, "write" if write else "read", "admitted", refs=refs)
        dispatch_id = call_id or uuid4().hex
        await self._reserve_dispatch(repository, capability, write, dispatch_id)
        auth = base64.b64encode(("x-access-token:" + token).encode()).decode()
        url = "https://github.com/" + repository + ".git/" + operation
        try:
            async with httpx.AsyncClient(
                timeout=httpx.Timeout(self.policy.timeout_seconds, connect=10), follow_redirects=False
            ) as client:
                async with client.stream(
                    method,
                    url,
                    params={"service": service} if service else None,
                    content=body,
                    headers={
                        "Authorization": "Basic " + auth,
                        "Content-Type": content_type,
                        "Accept": "application/x-"
                        + (service or operation)
                        + ("-advertisement" if method == "GET" else "-result"),
                    },
                ) as response:
                    if response.status_code != 200:
                        raise CodingAdmissionError("GitHub did not accept the admitted Git operation")
                    response.extensions["caipe_complete"] = False
                    yield response
                    complete = response.extensions.get("caipe_complete") is True
            if complete:
                await self._audit(repository, "write" if write else "read", "complete", refs=refs)
                await self._complete_dispatch(dispatch_id)
            else:
                await self._audit(repository, "write" if write else "read", "interrupted", refs=refs)
        except asyncio.CancelledError:
            await self._audit(repository, "cancel", "interrupted", refs=refs)
            raise
        finally:
            await self._audit(repository, "cleanup", "complete", refs=refs)


def git_environment(base: str, run_id: str, capability: str) -> dict[str, str]:
    """Git receives only scoped broker credentials, never a GitHub user token."""
    base = service_url(base)
    prefix = f"/api/v1/runs/{run_id}/git/github.com/"
    program = """import json,os,sys,urllib.request
if len(sys.argv)<2 or sys.argv[-1]!="get": sys.exit(0)
fields=dict(line.rstrip("\\n").split("=",1) for line in sys.stdin if "=" in line)
if fields.get("host")!=os.environ["CAIPE_GIT_HOST"] or fields.get("protocol")!=os.environ["CAIPE_GIT_SCHEME"]: sys.exit(1)
path=fields.get("path","")
prefix=os.environ["CAIPE_GIT_PATH_PREFIX"]
if not path.startswith(prefix.lstrip("/")) or not path.endswith(".git"): sys.exit(1)
repo=path[len(prefix.lstrip("/")):-4]
request=urllib.request.Request(os.environ["CAIPE_GIT_BROKER"]+"/git-capability",data=json.dumps({"repository":repo}).encode(),headers={"Content-Type":"application/json","X-CAIPE-Harness-Capability":os.environ["CAIPE_GIT_RUN_CAPABILITY"]})
class NoRedirect(urllib.request.HTTPRedirectHandler):
 def redirect_request(self,*args,**kwargs): raise ValueError("Git broker redirects are forbidden")
with urllib.request.build_opener(NoRedirect).open(request,timeout=20) as response: data=json.load(response)
print("username="+data["username"]+"\\npassword="+data["capability"]+"\\n")
"""
    helper = "!python3 -c " + shlex.quote(program)
    return {
        "GIT_TERMINAL_PROMPT": "0",
        "CAIPE_GIT_BROKER": f"{base}/api/v1/runs/{run_id}",
        "CAIPE_GIT_PATH_PREFIX": prefix,
        "CAIPE_GIT_RUN_CAPABILITY": capability,
        "CAIPE_GIT_HOST": urlsplit(base).netloc,
        "CAIPE_GIT_SCHEME": urlsplit(base).scheme,
        "GIT_CONFIG_COUNT": "3",
        "GIT_CONFIG_KEY_0": f"url.{base}{prefix}.insteadOf",
        "GIT_CONFIG_VALUE_0": "https://github.com/",
        "GIT_CONFIG_KEY_1": "credential.helper",
        "GIT_CONFIG_VALUE_1": helper,
        "GIT_CONFIG_KEY_2": "credential.useHttpPath",
        "GIT_CONFIG_VALUE_2": "true",
    }
