"""Fixtures and result reporting for the LLM gateway conformance suite.

The suite talks to a running gateway only. Inputs come from ``LLM_GW_CONFORMANCE_*``
environment variables; a check whose inputs are missing is reported as NOT_RUN.
"""

import json
from pathlib import Path

import httpx
import pytest

from .gateway import PREFIX, GatewayProfile, env, require

_RESULTS: dict[str, dict[str, str]] = {}


@pytest.fixture(scope="session")
def profile() -> GatewayProfile:
    gateway = GatewayProfile.from_env()
    require(gateway.base_url, PREFIX + "BASE_URL")
    return gateway


@pytest.fixture(scope="session")
def client(profile: GatewayProfile):
    with httpx.Client(base_url=profile.base_url, timeout=30.0) as http:
        yield http


def pytest_runtest_logreport(report: pytest.TestReport) -> None:
    check = report.nodeid.rsplit("::", 1)[-1]
    if report.skipped:
        status = "NOT_RUN"
    elif report.when == "call":
        status = "PASS" if report.passed else "FAIL"
    elif report.failed:
        status = "FAIL"
    else:
        return
    detail = str(report.longrepr[-1]) if report.skipped and isinstance(report.longrepr, tuple) else ""
    detail = dict(report.user_properties).get("detail", detail)
    _RESULTS[check] = {"status": status, "detail": detail.removeprefix("Skipped: ")}


def pytest_sessionfinish(session: pytest.Session) -> None:
    target = env("REPORT")
    if not target or not _RESULTS:
        return
    gateway = GatewayProfile.from_env()
    report = {
        "gateway": env("GATEWAY", "unspecified"),
        "gateway_version": env("GATEWAY_VERSION", "unspecified"),
        "auth_mode": gateway.auth,
        "base_url": gateway.base_url,
        "checks": _RESULTS,
    }
    Path(target).write_text(json.dumps(report, indent=2) + "\n")
