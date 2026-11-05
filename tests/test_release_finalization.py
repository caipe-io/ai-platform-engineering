"""Release completion must wake the finalizer without trusting fork/PR events."""

from __future__ import annotations

import os
import re
import subprocess
import textwrap
from pathlib import Path

import pytest

WORKFLOW = Path(__file__).resolve().parents[1] / ".github/workflows/release-finalize.yml"


def test_completion_triggers_cover_every_required_component() -> None:
    source = WORKFLOW.read_text()
    assert "actions/checkout@" not in source
    assert "actions/download-artifact@" not in source
    required = source.split("          REQUIRED_WORKFLOWS=(\n", 1)[1].split("          )", 1)[0]
    triggers = source.split("  workflow_run:\n", 1)[1].split("    types:", 1)[0]
    assert set(re.findall(r'"([^"\n]+)"', required)) == set(re.findall(r'"([^"\n]+)"', triggers))


@pytest.mark.parametrize("event,repository,branch,sha,accepted", [
    ("push", "example/project", "1.2.3", "a" * 40, True),
    ("pull_request", "example/project", "1.2.3", "a" * 40, False),
    ("push", "external/project", "1.2.3", "a" * 40, False),
    ("push", "example/project", "main", "a" * 40, False),
    ("push", "example/project", "1.2.3", "b" * 40, False),
])
def test_completion_payload_checks_origin_tag_and_commit(
    tmp_path: Path, event: str, repository: str, branch: str, sha: str, accepted: bool,
) -> None:
    source = WORKFLOW.read_text().split("        id: payload\n", 1)[1]
    script = textwrap.dedent(source.split("        run: |\n", 1)[1].split("\n      - name:", 1)[0])
    gh = tmp_path / "gh"
    gh.write_text('#!/bin/sh\nprintf "%s\\n" "$FAKE_TAG_SHA"\n')
    gh.chmod(0o700)
    output = tmp_path / "output"
    env = {**os.environ, "PATH": f"{tmp_path}:/usr/bin:/bin", "GITHUB_OUTPUT": str(output),
           "DISPATCH_TAG": "", "DISPATCH_WORKFLOW": "", "DISPATCH_CONCLUSION": "",
           "TRIGGER_EVENT": "workflow_run", "UPSTREAM_EVENT": event, "UPSTREAM_REPOSITORY": repository,
           "UPSTREAM_BRANCH": branch, "UPSTREAM_SHA": sha, "UPSTREAM_WORKFLOW": "[CI] Example",
           "UPSTREAM_CONCLUSION": "success", "GH_REPOSITORY": "example/project", "FAKE_TAG_SHA": "a" * 40}
    subprocess.run(["bash", "-c", script], env=env, capture_output=True, text=True, check=True)
    payload = output.read_text() if output.exists() else ""
    assert ("tag=1.2.3\n" in payload) is accepted
