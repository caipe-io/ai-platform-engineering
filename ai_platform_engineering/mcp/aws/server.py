# Copyright 2025 CNOE
# SPDX-License-Identifier: Apache-2.0
# assisted-by claude code claude-sonnet-4-6

"""
AWS MCP Server

Provides a Model Context Protocol (MCP) interface for AWS CLI and EKS kubectl
operations. Exposes read-only AWS CLI execute logic as MCP tools.
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

_SUPPORTED_CREDENTIAL_SOURCES = {
    "Environment",
    "EcsContainer",
    "Ec2InstanceMetadata",
}


# ---------------------------------------------------------------------------
# AWS profile setup
# ---------------------------------------------------------------------------

def _credential_source() -> str:
    """Return the AWS CLI credential source for assume-role profiles.

    EKS Pod Identity exposes credentials through the standard container
    credential endpoint, which the AWS CLI names ``EcsContainer``.  Preserve
    ``Environment`` as the fallback for local development and legacy installs.
    Operators may explicitly select any AWS CLI-supported source through
    ``AWS_CREDENTIAL_SOURCE``.
    """
    configured = os.getenv("AWS_CREDENTIAL_SOURCE", "").strip()
    if configured:
        if configured not in _SUPPORTED_CREDENTIAL_SOURCES:
            supported = ", ".join(sorted(_SUPPORTED_CREDENTIAL_SOURCES))
            raise ValueError(
                f"Unsupported AWS_CREDENTIAL_SOURCE '{configured}'. "
                f"Expected one of: {supported}."
            )
        return configured

    if os.getenv("AWS_CONTAINER_CREDENTIALS_FULL_URI") or os.getenv(
        "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI"
    ):
        return "EcsContainer"

    return "Environment"


def _single_line_env(name: str) -> str:
    """Read a config value while preventing AWS config-file injection."""
    value = os.getenv(name, "").strip()
    if "\n" in value or "\r" in value:
        raise ValueError(f"{name} must be a single-line value.")
    return value

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
    web_identity_role = _single_line_env("AWS_ROLE_ARN")
    web_identity_token_file = _single_line_env("AWS_WEB_IDENTITY_TOKEN_FILE")
    use_web_identity = bool(web_identity_role and web_identity_token_file)

    if use_web_identity:
        sections.append(
            "[profile mcp-workload-identity]\n"
            f"role_arn = {web_identity_role}\n"
            f"web_identity_token_file = {web_identity_token_file}\n"
            "role_session_name = mcp-aws\n"
        )
    else:
        credential_source = _credential_source()

    for acc in accounts:
        profile = (
            f"[profile {acc['name']}]\n"
            f"role_arn = arn:aws:iam::{acc['id']}:role/{cross_account_role}\n"
        )
        if use_web_identity:
            profile += "source_profile = mcp-workload-identity\n"
        else:
            profile += f"credential_source = {credential_source}\n"
        sections.append(profile)

    with open(os.path.join(aws_config_dir, "config"), "w") as fh:
        fh.write("\n".join(sections))

    source_type = "WebIdentity" if use_web_identity else credential_source
    logger.info(
        "Generated AWS profiles for %d accounts using %s: %s",
        len(accounts),
        source_type,
        [a["name"] for a in accounts],
    )
    return accounts


@functools.lru_cache(maxsize=None)
def _get_configured_profiles() -> list[str]:
    """Return profile names from AWS_ACCOUNT_LIST. Cached after first call."""
    return [a["name"] for a in _setup_aws_profiles()]


# ---------------------------------------------------------------------------
# AWS CLI tool
# ---------------------------------------------------------------------------

def _validate_aws_command(command: str) -> tuple[bool, str]:
    command = command.strip()
    for char in [";", "|", "&", "`", "$", "<", ">", "\\"]:
        if char in command:
            return False, f"Command contains shell character '{char}'. Use --query for filtering."
    parts = command.split()
    if not parts:
        return False, "Empty command provided."
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
    action = parts[1] if len(parts) > 1 else ""
    for indicator in write_indicators:
        if indicator in action.lower():
            return False, f"Write operation '{action}' detected. Only read operations are allowed."
    return True, ""


async def aws_cli_execute(
    command: str,
    profile: str,
    region: Optional[str] = None,
    output_format: Optional[str] = "json",
    jq_filter: Optional[str] = None,
) -> str:
    """
    Execute an AWS CLI read-only command against a specific AWS account.

    The 'aws' prefix must be omitted — pass only the service and subcommand.
    All write/destructive operations (create, delete, update, terminate, …) are
    blocked. Use describe-*, list-*, get-* operations.

    Args:
        command: AWS CLI command without the 'aws' prefix.
            Examples: 'ec2 describe-instances', 's3 ls', 'iam list-roles',
            'eks list-clusters --region us-west-2'.
        profile: AWS profile name for the target account. REQUIRED — when the
            user asks for 'all accounts', make separate calls with each profile.
            If AWS_ACCOUNT_LIST is not configured, pass an empty string to use
            environment-variable credentials directly.
        region: AWS region override. Defaults to AWS_REGION / AWS_DEFAULT_REGION
            environment variable, or 'us-west-2' if neither is set.
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
        mcp.run(transport=MCP_MODE.lower(), host=MCP_HOST, port=MCP_PORT)
    else:
        mcp.run(transport=MCP_MODE.lower())


if __name__ == "__main__":
    main()
