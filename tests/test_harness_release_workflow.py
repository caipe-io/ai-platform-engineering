"""Exercise release shell scripts without publishing images or dispatching events."""

import json
import os
import subprocess
from pathlib import Path

import pytest
import yaml

ROOT = Path(__file__).resolve().parents[1]
WORKFLOW = yaml.safe_load((ROOT / ".github/workflows/ci-harness-engine.yml").read_text())


@pytest.mark.parametrize("tag,ref_type,latest", [
    ("1.2.3", "tag", True),
    ("1.2.3", "branch", False),
    ("1.2.3-rc.1", "branch", False),
    ("1.2.3-hotfix.1", "branch", False),
    ("1.2.3-rc.1", "tag", False),
    ("1.2.3-hotfix.1", "tag", False),
])
def test_only_final_tag_updates_latest(tmp_path: Path, tag: str, ref_type: str, latest: bool) -> None:
    docker = tmp_path / "docker"
    docker.write_text('#!/bin/sh\nprintf "%s\\n" "$*" >> "$CALLS"\n')
    docker.chmod(0o700)
    calls = tmp_path / "calls"
    script = next(s["run"] for s in WORKFLOW["jobs"]["manifests"]["steps"] if s.get("name") == "Publish source tag and stable latest alias")
    env = {**os.environ, "PATH": f"{tmp_path}:{os.environ['PATH']}", "CALLS": str(calls),
           "IMAGE": "registry.example.test/example", "TAG": tag, "REVISION": "a" * 40,
           "REF_TYPE": ref_type, "GITHUB_STEP_SUMMARY": str(tmp_path / "summary")}
    subprocess.run(["bash", "-c", script], env=env, check=True, capture_output=True)
    assert ("registry.example.test/example:latest" in calls.read_text()) is latest


def test_failed_metadata_still_dispatches_final_release_failure(tmp_path: Path) -> None:
    job = WORKFLOW["jobs"]["notify-release"]
    assert "always()" in job["if"]
    step = next(s for s in job["steps"] if s.get("name") == "Notify release gate")
    assert step["env"]["TAG"] == "${{ github.ref_name }}"
    gh = tmp_path / "gh"
    gh.write_text('#!/bin/sh\ncat > "$PAYLOAD"\n')
    gh.chmod(0o700)
    payload = tmp_path / "payload"
    env = {**os.environ, "PATH": f"{tmp_path}:{os.environ['PATH']}", "PAYLOAD": str(payload),
           "TAG": "1.2.3", "REPOSITORY": "example/project", "WORKFLOW": "Example build",
           "IMAGES_RESULT": "skipped", "MANIFESTS_RESULT": "skipped"}
    subprocess.run(["bash", "-c", step["run"]], env=env, check=True, capture_output=True)
    assert json.loads(payload.read_text())["client_payload"] == {
        "tag": "1.2.3", "workflow": "Example build", "conclusion": "failure",
    }
