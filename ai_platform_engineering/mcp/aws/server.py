# Copyright 2025 CNOE
# SPDX-License-Identifier: Apache-2.0
# assisted-by claude code claude-sonnet-4-6

"""
AWS MCP Server

Provides a Model Context Protocol (MCP) interface for AWS CLI and EKS kubectl
operations. Exposes read-only AWS CLI execute logic plus one IAM-scoped EC2
stop action as MCP tools.
"""

import asyncio
import functools
import json
import logging
import os
import re
import shlex
import tempfile
from typing import Optional

from dotenv import load_dotenv
from fastmcp import FastMCP
import jwt
from mcp_agent_auth.middleware import MCPAuthMiddleware
from mcp_agent_auth.token_context import current_bearer_token
from starlette.middleware import Middleware


# ---------------------------------------------------------------------------
# Configuration (mirrors tools.py constants; read at server startup)
# ---------------------------------------------------------------------------

BLOCKED_COMMAND_PATTERNS = [
    r"--delete-bucket",
    r"delete-bucket",
    r"terminate-instances",
    r"delete-cluster",
    r"delete-stack",
    r"delete-db-instance",
    r"delete-table",
    r"delete-function",
    r"delete-role",
    r"delete-user",
    r"delete-policy",
    r"delete-secret",
    r"delete-key",
    r"rm\s+--recursive",
    r"s3\s+rm.*--recursive",
    r"delete-security-group",
    r"delete-vpc",
    r"delete-subnet",
    r"revoke-security-group",
]

AWS_CLI_TIMEOUT = int(os.getenv("AWS_CLI_MAX_EXECUTION_TIME", "30"))
KUBECTL_TIMEOUT = int(os.getenv("KUBECTL_MAX_EXECUTION_TIME", "45"))
JQ_TIMEOUT = 10

RESTRICT_KUBECTL_SECRETS = os.getenv("RESTRICT_KUBECTL_SECRETS", "true").lower() == "true"
RESTRICT_KUBECTL_PROXY = os.getenv("RESTRICT_KUBECTL_PROXY", "true").lower() == "true"
RESTRICT_KUBECTL_EXEC = os.getenv("RESTRICT_KUBECTL_EXEC", "false").lower() == "true"
RESTRICT_KUBECTL_ATTACH = os.getenv("RESTRICT_KUBECTL_ATTACH", "false").lower() == "true"
RESTRICT_KUBECTL_CP = os.getenv("RESTRICT_KUBECTL_CP", "false").lower() == "true"
RESTRICT_KUBECTL_PORT_FORWARD = os.getenv("RESTRICT_KUBECTL_PORT_FORWARD", "false").lower() == "true"

MAX_OUTPUT_SIZE = int(os.getenv("AWS_CLI_MAX_OUTPUT_SIZE", "20000"))
MAX_CONCURRENT_AWS_CALLS = int(os.getenv("MAX_CONCURRENT_AWS_CALLS", "10"))
MAX_CONCURRENT_KUBECTL_CALLS = int(os.getenv("MAX_CONCURRENT_KUBECTL_CALLS", "5"))

_aws_cli_semaphore: asyncio.Semaphore
_kubectl_semaphore: asyncio.Semaphore

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# AWS profile setup
# ---------------------------------------------------------------------------

def _setup_aws_profiles() -> list[dict]:
    """Read AWS_ACCOUNT_LIST and write ~/.aws/config with assume-role profiles."""
    aws_account_list = os.getenv("AWS_ACCOUNT_LIST", "")
    if not aws_account_list:
        return []

    accounts = []
    for entry in aws_account_list.split(","):
        entry = entry.strip()
        if not entry:
            continue
        if ":" in entry:
            name, account_id = entry.split(":", 1)
            accounts.append({"name": name.strip(), "id": account_id.strip()})
        else:
            accounts.append({"name": entry, "id": entry})

    if not accounts:
        return []

    cross_account_role = os.getenv("CROSS_ACCOUNT_ROLE_NAME", "caipe-read-only")
    aws_config_dir = os.path.expanduser("~/.aws")
    os.makedirs(aws_config_dir, exist_ok=True)

    sections = ["# AUTO-GENERATED PROFILES FROM AWS_ACCOUNT_LIST\n"]
    for acc in accounts:
        sections.append(
            f"[profile {acc['name']}]\n"
            f"role_arn = arn:aws:iam::{acc['id']}:role/{cross_account_role}\n"
            f"credential_source = Environment\n"
        )

    with open(os.path.join(aws_config_dir, "config"), "w") as fh:
        fh.write("\n".join(sections))

    logger.info("Generated AWS profiles for %d accounts: %s", len(accounts), [a["name"] for a in accounts])
    return accounts


@functools.lru_cache(maxsize=None)
def _get_configured_profiles() -> list[str]:
    """Return profile names from AWS_ACCOUNT_LIST. Cached after first call."""
    return [a["name"] for a in _setup_aws_profiles()]


# ---------------------------------------------------------------------------
# AWS CLI tool
# ---------------------------------------------------------------------------

def _configured_write_operations() -> set[str]:
    """Return explicitly enabled AWS write operations (service.operation)."""
    configured = os.getenv("AWS_ALLOWED_WRITE_COMMANDS", "ec2.stop-instances")
    return {item.strip().lower() for item in configured.split(",") if item.strip()}


def _validate_aws_command(command: str) -> tuple[bool, str]:
    command = command.strip()
    for char in [";", "|", "&", "`", "$", "<", ">", "\\"]:
        if char in command:
            return False, f"Command contains shell character '{char}'. Use --query for filtering."
    try:
        parts = shlex.split(command)
    except ValueError as exc:
        return False, f"Invalid command syntax: {exc}"
    if len(parts) < 2:
        return False, "A service and operation are required."

    operation = ".".join(parts[:2]).lower()
    if operation in _configured_write_operations():
        # The target profile and region must come from tool inputs. Do not let
        # command arguments switch credentials, region, endpoint, or output.
        protected_options = {"--profile", "--region", "--output", "--endpoint-url"}
        if any(part.split("=", 1)[0] in protected_options for part in parts[2:]):
            return False, "Write commands cannot override profile, region, output, or endpoint options."
        if operation == "ec2.stop-instances":
            if (
                len(parts) == 4
                and parts[2] == "--instance-ids"
                and re.fullmatch(r"i-[0-9a-f]{8,17}", parts[3])
            ):
                return True, ""
            return False, "Only one EC2 instance ID may be stopped per request."
        return True, ""

    for pattern in BLOCKED_COMMAND_PATTERNS:
        if re.search(pattern, command, re.IGNORECASE):
            return False, f"Command matches blocked pattern '{pattern}'. Destructive operations are disabled."
    write_indicators = [
        "create-", "delete-", "put-", "update-", "modify-",
        "attach-", "detach-", "associate-", "disassociate-",
        "start-", "stop-", "terminate-", "reboot-",
        "enable-", "disable-", "register-", "deregister-",
        "add-", "remove-", "copy-", "import-", "export-",
        "run-", "invoke-", "execute-", "send-",
    ]
    action = parts[1]
    for indicator in write_indicators:
        if indicator in action.lower():
            return False, f"Write operation '{action}' is not enabled. Configure AWS_ALLOWED_WRITE_COMMANDS to allow it."
    return True, ""


def _authenticated_username() -> str | None:
    """Return the configured identity claim from the JWT verified by middleware."""
    token = current_bearer_token.get()
    if not token:
        return None
    try:
        claims = jwt.decode(
            token,
            options={"verify_signature": False, "verify_exp": False, "verify_aud": False},
        )
    except jwt.InvalidTokenError:
        return None

    claim_name = os.getenv("MCP_AUTH_USERNAME_CLAIM", "preferred_username")
    username = claims.get(claim_name)
    if not isinstance(username, str) or not re.fullmatch(r"[A-Za-z0-9._-]{1,64}", username):
        return None
    return username


async def _execute_authorized_write(
    command_parts: list[str], username: str, profile: str, region: str, output_format: str
) -> str:
    """Assume a tagged target role and execute an explicitly allowed operation."""
    accounts: dict[str, str] = {}
    for entry in os.getenv("AWS_ACCOUNT_LIST", "").split(","):
        entry = entry.strip()
        if not entry:
            continue
        if ":" in entry:
            account_name, account_id = entry.split(":", 1)
            accounts[account_name.strip()] = account_id.strip()
        else:
            accounts[entry] = entry
    account_id = accounts.get(profile)
    if not account_id:
        return f"❌ AWS profile '{profile}' is not configured for cross-account access."

    role_name = os.getenv("CROSS_ACCOUNT_ROLE_NAME", "caipe-read-only")
    role_arn = f"arn:aws:iam::{account_id}:role/{role_name}"
    session_name = re.sub(r"[^A-Za-z0-9_+=,.@-]", "_", f"mcp-{username}")[:64]
    tag_key = os.getenv("AWS_IDENTITY_SESSION_TAG", "username")

    source_env = {**os.environ}
    source_env.pop("AWS_PROFILE", None)
    source_env.pop("AWS_DEFAULT_PROFILE", None)
    assume_role_command = [
        "aws", "sts", "assume-role",
        "--role-arn", role_arn,
        "--role-session-name", session_name,
        "--tags", f"Key={tag_key},Value={username}",
        "--transitive-tag-keys", tag_key,
        "--duration-seconds", "900",
        "--output", "json",
    ]

    try:
        assume_proc = await asyncio.create_subprocess_exec(
            *assume_role_command,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=source_env,
        )
        try:
            assume_out, assume_err = await asyncio.wait_for(
                assume_proc.communicate(), timeout=AWS_CLI_TIMEOUT
            )
        except asyncio.TimeoutError:
            assume_proc.kill()
            await assume_proc.wait()
            raise
        if assume_proc.returncode != 0:
            return f"❌ Could not assume the tagged AWS role: {assume_err.decode(errors='replace')}"
        credentials = json.loads(assume_out).get("Credentials", {})
        if not all(credentials.get(key) for key in ("AccessKeyId", "SecretAccessKey", "SessionToken")):
            return "❌ AWS STS did not return temporary credentials."

        write_env = {**source_env}
        write_env.pop("AWS_ROLE_ARN", None)
        write_env.pop("AWS_WEB_IDENTITY_TOKEN_FILE", None)
        write_env.update({
            "AWS_ACCESS_KEY_ID": credentials["AccessKeyId"],
            "AWS_SECRET_ACCESS_KEY": credentials["SecretAccessKey"],
            "AWS_SESSION_TOKEN": credentials["SessionToken"],
            "AWS_REGION": region,
            "AWS_DEFAULT_REGION": region,
        })
        aws_command = ["aws", *command_parts, "--region", region, "--output", output_format]
        operation_proc = await asyncio.create_subprocess_exec(
            *aws_command,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=write_env,
        )
        try:
            operation_out, operation_err = await asyncio.wait_for(
                operation_proc.communicate(), timeout=AWS_CLI_TIMEOUT
            )
        except asyncio.TimeoutError:
            operation_proc.kill()
            await operation_proc.wait()
            raise
        if operation_proc.returncode != 0:
            return f"❌ AWS operation failed: {operation_err.decode(errors='replace')}"
        return operation_out.decode(errors="replace") or "✅ AWS operation completed."
    except asyncio.TimeoutError:
        return f"❌ AWS operation timed out after {AWS_CLI_TIMEOUT} seconds."
    except FileNotFoundError:
        return "❌ AWS CLI not found. Ensure it is installed in the container."
    except (json.JSONDecodeError, OSError) as exc:
        logger.error("AWS write operation failed: %s", exc)
        return "❌ AWS write operation failed."


async def aws_cli_execute(
    command: str,
    profile: str,
    region: Optional[str] = None,
    output_format: Optional[str] = "json",
    jq_filter: Optional[str] = None,
) -> str:
    """
    Execute a read-only AWS CLI command or an explicitly enabled write operation.

    The 'aws' prefix must be omitted — pass only the service and operation.
    Configure ``AWS_ALLOWED_WRITE_COMMANDS`` with comma-separated
    ``service.operation`` names. OAuth2 identity is passed as an STS session tag;
    the target role's IAM policy authorizes the actual account, region, and resources.

    Args:
        command: AWS CLI command without the 'aws' prefix.
            Examples: 'ec2 describe-instances', 's3 ls', 'iam list-roles',
            'eks list-clusters --region us-west-2'.
        profile: AWS profile name for the target account. REQUIRED — when the
            user asks for 'all accounts', make separate calls with each profile.
            If AWS_ACCOUNT_LIST is not configured, pass an empty string to use
            environment-variable credentials directly. Write requests require a
            configured cross-account profile so the identity session tag can be passed.
        region: AWS region override. Defaults to AWS_REGION / AWS_DEFAULT_REGION
            environment variable, or 'us-west-2' if neither is set. IAM policies
            determine which regions and resources can be modified.
        output_format: CLI output format — json (default), text, table, or yaml.
        jq_filter: Optional jq expression applied to JSON output. Useful for
            extracting specific fields, e.g.
            '.Reservations[].Instances[] | {ID: .InstanceId, State: .State.Name}'.
    """
    is_valid, error_msg = _validate_aws_command(command)
    if not is_valid:
        logger.warning("AWS CLI command validation failed: %s", error_msg)
        return f"❌ Command validation failed: {error_msg}"

    aws_region = region or os.getenv("AWS_REGION", os.getenv("AWS_DEFAULT_REGION", "us-west-2"))
    output_fmt = "json" if jq_filter else (output_format if output_format in ["json", "text", "table", "yaml"] else "json")

    configured_profiles = _get_configured_profiles()
    profile_prefix = f"--profile {profile} " if (configured_profiles and profile) else ""

    command_parts = shlex.split(command)
    operation = ".".join(command_parts[:2]).lower()
    if operation in _configured_write_operations():
        if os.getenv("MCP_AUTH_MODE", "none").lower() != "oauth2":
            return "❌ Write requests require OAuth2 bearer-token authentication."
        username = _authenticated_username()
        if not username:
            return "❌ Write requests require a verified identity claim."
        async with _aws_cli_semaphore:
            return await _execute_authorized_write(command_parts, username, profile, aws_region, output_fmt)

    if "--region" in command:
        full_command = f"aws {profile_prefix}{command} --output {output_fmt}"
    else:
        full_command = f"aws {profile_prefix}{command} --region {aws_region} --output {output_fmt}"

    logger.info("Executing AWS CLI: %s", full_command)

    async with _aws_cli_semaphore:
        try:
            process = await asyncio.create_subprocess_shell(
                full_command,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                env={**os.environ},
            )
            try:
                stdout, stderr = await asyncio.wait_for(process.communicate(), timeout=AWS_CLI_TIMEOUT)
            except asyncio.TimeoutError:
                process.kill()
                await process.wait()
                return f"❌ Command timed out after {AWS_CLI_TIMEOUT} seconds."

            stdout_str = stdout.decode("utf-8", errors="replace")
            stderr_str = stderr.decode("utf-8", errors="replace")

            if process.returncode != 0:
                return f"❌ Command failed (exit {process.returncode}):\n{stderr_str or stdout_str}"

            if jq_filter and stdout_str:
                stdout_str = await _apply_jq(stdout_str, jq_filter)

            if len(stdout_str) > MAX_OUTPUT_SIZE:
                stdout_str = stdout_str[:MAX_OUTPUT_SIZE] + f"\n\n... [Truncated. Total: {len(stdout_str)} chars]"

            return stdout_str or "✅ Command completed (no output)."

        except FileNotFoundError:
            return "❌ AWS CLI not found. Ensure it is installed in the container."
        except Exception as exc:
            logger.error("AWS CLI execution error: %s", exc)
            return f"❌ Error: {exc}"


async def _apply_jq(data: str, jq_filter: str) -> str:
    """Apply a jq filter to JSON data, returning the filtered result or a warning."""
    with tempfile.NamedTemporaryFile(mode="w", suffix=".json", delete=False) as fh:
        fh.write(data)
        tmp = fh.name

    try:
        safe_filter = jq_filter.replace("'", "'\"'\"'")
        proc = await asyncio.create_subprocess_shell(
            f"jq '{safe_filter}' {tmp}",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        jq_out, jq_err = await asyncio.wait_for(proc.communicate(), timeout=JQ_TIMEOUT)
        if proc.returncode == 0:
            return jq_out.decode("utf-8", errors="replace")
        err = jq_err.decode("utf-8", errors="replace")
        logger.warning("jq filter failed: %s", err)
        return f"⚠️ jq filter failed ({err}), showing raw output:\n\n{data}"
    except Exception as exc:
        logger.warning("jq processing error: %s", exc)
        return f"⚠️ jq processing failed ({exc}), showing raw output:\n\n{data}"
    finally:
        try:
            os.unlink(tmp)
        except Exception:
            pass


# ---------------------------------------------------------------------------
# kubectl restriction helpers
# ---------------------------------------------------------------------------

def _validate_kubectl_command(kubectl_command: str) -> tuple[bool, str]:
    stripped = kubectl_command.strip()
    checks = [
        (RESTRICT_KUBECTL_SECRETS,
         [r"^\s*get\s+secrets?(\s|/|$)", r"^\s*describe\s+secrets?(\s|/|$)"],
         "kubectl get/describe secret(s) is blocked to prevent secret data from reaching the LLM."),
        (RESTRICT_KUBECTL_PROXY,
         [r"^\s*proxy(\s|$)"],
         "kubectl proxy is blocked — it exposes the entire Kubernetes API server."),
        (RESTRICT_KUBECTL_EXEC,
         [r"^\s*exec(\s|$)"],
         "kubectl exec is blocked — it provides shell access inside pods."),
        (RESTRICT_KUBECTL_ATTACH,
         [r"^\s*attach(\s|$)"],
         "kubectl attach is blocked — it attaches to a running process."),
        (RESTRICT_KUBECTL_CP,
         [r"^\s*cp(\s|$)"],
         "kubectl cp is blocked — it can copy files out of pods."),
        (RESTRICT_KUBECTL_PORT_FORWARD,
         [r"^\s*port-forward(\s|$)"],
         "kubectl port-forward is blocked — it tunnels internal services."),
    ]
    for enabled, patterns, message in checks:
        if enabled:
            for pat in patterns:
                if re.search(pat, stripped, re.IGNORECASE):
                    return False, message
    return True, ""


def _redact_json_secrets(obj):
    """Recursively redact Secret .data fields from parsed JSON."""
    if isinstance(obj, dict):
        if obj.get("kind") == "Secret" and "data" in obj:
            redacted = dict(obj)
            redacted["data"] = {k: "[REDACTED]" for k in obj["data"]}
            return redacted, True
        new_obj, was_redacted = {}, False
        for k, v in obj.items():
            new_v, r = _redact_json_secrets(v)
            new_obj[k] = new_v
            was_redacted = was_redacted or r
        return (new_obj if was_redacted else obj), was_redacted
    if isinstance(obj, list):
        new_list, was_redacted = [], False
        for item in obj:
            new_item, r = _redact_json_secrets(item)
            new_list.append(new_item)
            was_redacted = was_redacted or r
        return (new_list if was_redacted else obj), was_redacted
    return obj, False


def _sanitize_kubectl_output(output: str) -> str:
    """Redact Secret data values from kubectl output before returning to the LLM."""
    if not output or not RESTRICT_KUBECTL_SECRETS:
        return output
    try:
        parsed = json.loads(output)
        redacted, was_redacted = _redact_json_secrets(parsed)
        if was_redacted:
            logger.warning("Secret data found in kubectl output — redacting.")
            return json.dumps(redacted, indent=2)
        return output
    except (json.JSONDecodeError, ValueError):
        pass

    # Fall back to line-by-line YAML sanitization
    lines = output.split("\n")
    result: list[str] = []
    in_secret = in_data = False
    data_indent = -1
    for line in lines:
        stripped = line.strip()
        if stripped == "kind: Secret":
            in_secret, in_data, data_indent = True, False, -1
            result.append(line)
            continue
        if in_secret and re.match(r"^kind:\s+\S", stripped) and stripped != "kind: Secret":
            in_secret = in_data = False
            data_indent = -1
        if in_secret and stripped == "data:":
            in_data = True
            data_indent = len(line) - len(line.lstrip())
            result.append(line)
            continue
        if in_data and stripped:
            current_indent = len(line) - len(line.lstrip())
            if current_indent > data_indent and ":" in stripped:
                key = stripped.split(":", 1)[0]
                result.append(f"{' ' * current_indent}{key}: [REDACTED]")
                continue
            elif current_indent <= data_indent:
                in_data = False
        result.append(line)
    return "\n".join(result)


# ---------------------------------------------------------------------------
# EKS kubectl tool
# ---------------------------------------------------------------------------

async def eks_kubectl_execute(
    cluster_name: str,
    kubectl_command: str,
    profile: str,
    region: Optional[str] = None,
) -> str:
    """
    Execute a kubectl command against an Amazon EKS cluster.

    The tool automatically handles kubeconfig setup via
    'aws eks update-kubeconfig' and cleans up the temporary file afterwards.
    Secret data is redacted from all output before returning to the LLM.

    Blocked (configurable via env vars):
      - get/describe secret(s)  — RESTRICT_KUBECTL_SECRETS (default: true)
      - proxy                   — RESTRICT_KUBECTL_PROXY   (default: true)
      - exec / attach / cp / port-forward — default: false (opt-in)

    Args:
        cluster_name: EKS cluster name, e.g. 'eks-gitops-1'.
        kubectl_command: kubectl subcommand without the 'kubectl' prefix.
            Examples: 'get nodes', 'get pods -n kube-system --all-namespaces',
            'describe node <name>', 'logs <pod> -n <ns> --tail 100',
            'top nodes', 'get events --sort-by=.lastTimestamp'.
        profile: AWS profile name for the account containing the cluster.
            Pass an empty string to use environment-variable credentials.
        region: AWS region where the cluster resides. Defaults to the profile
            default or AWS_REGION / AWS_DEFAULT_REGION env var.
    """
    is_valid, error_msg = _validate_kubectl_command(kubectl_command)
    if not is_valid:
        return f"❌ Command blocked: {error_msg}"

    logger.info("EKS kubectl: cluster=%s profile=%s command='%s'", cluster_name, profile, kubectl_command)

    async with _kubectl_semaphore:
        loop = asyncio.get_event_loop()
        return await loop.run_in_executor(None, _run_kubectl, cluster_name, kubectl_command, profile, region)


def _run_kubectl(cluster_name: str, kubectl_command: str, profile: str, region: Optional[str]) -> str:
    """Synchronous kubectl execution (run in executor to avoid blocking the event loop)."""
    import subprocess

    kubeconfig_path = None
    try:
        tmp = tempfile.NamedTemporaryFile(mode="w", delete=False, suffix=".kubeconfig")
        kubeconfig_path = tmp.name
        tmp.close()

        update_cmd = ["aws", "eks", "update-kubeconfig", "--name", cluster_name, "--kubeconfig", kubeconfig_path]
        if _get_configured_profiles() and profile:
            update_cmd.extend(["--profile", profile])
        if region:
            update_cmd.extend(["--region", region])

        update_result = subprocess.run(update_cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                       timeout=KUBECTL_TIMEOUT, check=False)
        if update_result.returncode != 0:
            err = update_result.stderr.decode("utf-8") if update_result.stderr else "Unknown error"
            _safe_unlink(kubeconfig_path)
            return f"❌ Failed to configure kubectl for cluster {cluster_name}: {err}"

        kubectl_parts = ["kubectl"] + shlex.split(kubectl_command)
        env = {**os.environ, "KUBECONFIG": kubeconfig_path}

        kubectl_result = subprocess.run(kubectl_parts, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                        env=env, timeout=KUBECTL_TIMEOUT, check=False)
        _safe_unlink(kubeconfig_path)

        output = kubectl_result.stdout.decode("utf-8") if kubectl_result.stdout else ""
        err_output = kubectl_result.stderr.decode("utf-8") if kubectl_result.stderr else ""

        if kubectl_result.returncode != 0:
            return f"❌ kubectl command failed:\n{err_output}"

        if len(output) > MAX_OUTPUT_SIZE:
            output = output[:MAX_OUTPUT_SIZE] + f"\n\n⚠️ Truncated (original: {len(output)} bytes)"

        output = _sanitize_kubectl_output(output)
        return f"✅ kubectl {kubectl_command}\n\n{output}"

    except subprocess.TimeoutExpired:
        _safe_unlink(kubeconfig_path)
        return f"❌ Command timed out after {KUBECTL_TIMEOUT} seconds."
    except Exception as exc:
        _safe_unlink(kubeconfig_path)
        logger.error("kubectl execution error: %s", exc, exc_info=True)
        return f"❌ Error: {exc}"


def _safe_unlink(path: Optional[str]) -> None:
    if path:
        try:
            os.unlink(path)
        except Exception as exc:
            logger.debug("Could not remove temp file %s: %s", path, exc)


# ---------------------------------------------------------------------------
# Server entry point
# ---------------------------------------------------------------------------

def main():
    load_dotenv()

    logging.basicConfig(level=logging.DEBUG)
    logging.getLogger("sse_starlette.sse").setLevel(logging.INFO)
    logging.getLogger("mcp.server.lowlevel.server").setLevel(logging.INFO)

    MCP_MODE = os.getenv("MCP_MODE", "STDIO")
    MCP_HOST = os.getenv("MCP_HOST", "localhost")
    MCP_PORT = int(os.getenv("MCP_PORT", "8000"))
    SERVER_NAME = os.getenv("SERVER_NAME", "AWS")

    logger.info("Starting %s MCP server in %s mode on %s:%s", SERVER_NAME, MCP_MODE, MCP_HOST, MCP_PORT)

    # Initialize semaphores now that the event loop exists
    global _aws_cli_semaphore, _kubectl_semaphore
    _aws_cli_semaphore = asyncio.Semaphore(MAX_CONCURRENT_AWS_CALLS)
    _kubectl_semaphore = asyncio.Semaphore(MAX_CONCURRENT_KUBECTL_CALLS)

    # Configure cross-account profiles if AWS_ACCOUNT_LIST is set
    accounts = _setup_aws_profiles()
    if accounts:
        logger.info("Configured AWS profiles: %s", [a["name"] for a in accounts])

    mcp = FastMCP(f"{SERVER_NAME} MCP Server")
    mcp.tool()(aws_cli_execute)
    mcp.tool()(eks_kubectl_execute)

    if MCP_MODE.lower() in ["sse", "http"]:
        if MCP_MODE.lower() == "http":
            mcp.run(
                transport="http",
                host=MCP_HOST,
                port=MCP_PORT,
                middleware=[Middleware(MCPAuthMiddleware)],
            )
        else:
            mcp.run(transport="sse", host=MCP_HOST, port=MCP_PORT)
    else:
        mcp.run(transport=MCP_MODE.lower())


if __name__ == "__main__":
    main()
