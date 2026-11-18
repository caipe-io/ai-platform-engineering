"""Exercise stable release validation, image channels, and changelog rollups."""

import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tomllib

import pytest
import yaml


ROOT = Path(__file__).resolve().parents[3]


def action_script(action: str, step: str) -> str:
  data = yaml.safe_load((ROOT / ".github/actions" / action / "action.yml").read_text())
  return next(item["run"] for item in data["runs"]["steps"] if step in item["name"])


@pytest.fixture
def repository(tmp_path: Path) -> Path:
  def git(*args: str) -> None:
    subprocess.run(["git", *args], cwd=tmp_path, check=True, capture_output=True)

  git("init", "-q")
  git("config", "user.name", "Test User")
  git("config", "user.email", "test-user@example.com")
  git("config", "commit.gpgsign", "false")
  git("config", "tag.gpgsign", "false")
  git("config", "core.hooksPath", "/dev/null")
  git("remote", "add", "origin", str(tmp_path))
  git("commit", "--allow-empty", "-qm", "feat: initial release")
  git("tag", "1.0.0")
  return tmp_path


@pytest.mark.parametrize(
  ("version", "base", "suffix", "valid"),
  [
    ("1.1.0", "", "", True),
    ("1.1.0-rc.1", "", "", False),
    ("1.1.0-dev.1", "", "", False),
    ("01.1.0", "", "", False),
    ("1.0.0", "", "", False),
    ("0.9.0", "", "", False),
    ("1.1.0-rc.2", "1.1.0", "rc", True),
    ("1.1.0-rc.1", "1.1.0", "rc", False),
    ("0.9.0-hotfix.2", "0.9.0", "hotfix", True),
  ],
)
def test_release_tag_policy(
  repository: Path,
  version: str,
  base: str,
  suffix: str,
  valid: bool,
) -> None:
  for tag in ("1.1.0-rc.1", "0.9.0-hotfix.1"):
    subprocess.run(["git", "tag", tag], cwd=repository, check=True)
  result = subprocess.run(
    ["bash", "-c", action_script("validate-release-tag", "Validate version")],
    cwd=repository,
    env={**os.environ, "VERSION": version, "BASE_VERSION": base, "SUFFIX_TYPE": suffix},
    text=True,
    capture_output=True,
  )
  assert (result.returncode == 0) is valid, result.stdout + result.stderr


@pytest.mark.parametrize(
  ("pushed", "manual", "main", "event", "ref", "tag", "stable"),
  [
    ("1.1.0", "", "", "push", "refs/tags/1.1.0", "1.1.0", True),
    ("1.1.0-rc.1", "", "", "push", "refs/tags/1.1.0-rc.1", "1.1.0-rc.1", False),
    ("", "1.1.0-rc.2", "", "workflow_dispatch", "refs/heads/main", "1.1.0-rc.2", False),
    ("", "1.1.0", "", "workflow_dispatch", "refs/heads/main", "1.1.0", True),
    ("", "1.0.0-dev.1", "", "workflow_dispatch", "refs/heads/main", "1.0.0-dev.1", False),
    ("", "0.9.0-hotfix.1", "", "workflow_dispatch", "refs/heads/main", "0.9.0-hotfix.1", False),
    ("", "", "canary", "push", "refs/heads/main", "canary", False),
    ("", "", "", "workflow_dispatch", "refs/heads/main", "canary", False),
    ("", "", "", "pull_request", "refs/pull/1/merge", "", False),
    ("1.1.0-rc.1", "1.1.0", "", "workflow_dispatch", "refs/tags/1.1.0-rc.1", "1.1.0-rc.1", False),
  ],
)
def test_only_stable_images_qualify_for_latest(
  tmp_path: Path,
  pushed: str,
  manual: str,
  main: str,
  event: str,
  ref: str,
  tag: str,
  stable: bool,
) -> None:
  output = tmp_path / "outputs"
  result = subprocess.run(
    ["bash", "-c", action_script("determine-release-tag", "Collect Final Tag")],
    env={
      **os.environ,
      "TAG_PUSH_OUTPUT": pushed,
      "MANUAL_RUN_OUTPUT": manual,
      "MAIN_PUSH_OUTPUT": main,
      "EVENT_NAME": event,
      "REF_NAME": ref,
      "GITHUB_OUTPUT": str(output),
    },
    text=True,
    capture_output=True,
  )
  assert result.returncode == 0, result.stdout + result.stderr
  values = dict(line.split("=", 1) for line in output.read_text().splitlines())
  assert values == {"tag_version": tag, "is_final_release": str(stable).lower()}


def test_image_workflows_use_the_shared_channel_decision() -> None:
  for path in (ROOT / ".github/workflows").glob("ci-*.yml"):
    text = path.read_text()
    aliases = [line.strip() for line in text.splitlines() if "type=raw,value=latest" in line]
    if not aliases:
      assert "docker/metadata-action" not in text, path
      continue
    jobs = yaml.safe_load(text)["jobs"]
    resolver_name, resolver = next((name, job) for name, job in jobs.items() if "is_final_release" in job.get("outputs", {}))
    assert resolver["outputs"]["is_final_release"] == ("${{ steps.version.outputs.is_final_release }}"), path
    assert all(line == ("type=raw,value=latest,enable=${{ needs." + resolver_name + ".outputs.is_final_release == 'true' }}") for line in aliases), path


@pytest.mark.parametrize("head_tag", ["1.1.0-rc.2", "1.0.1-dev.2", "1.0.0-hotfix.2"])
def test_changelog_rolls_up_prereleases_and_preserves_published_history(repository: Path, head_tag: str) -> None:
  config = tomllib.loads((ROOT / "pyproject.toml").read_text())["tool"]["commitizen"]
  keys = ("name", "tag_format", "version_scheme", "changelog_merge_prerelease", "changelog_incremental", "ignored_tag_formats")
  lines = ["[tool.commitizen]"]
  for key in keys:
    value = config[key]
    literal = json.dumps(value)
    lines.append(f"{key} = {literal}")
  (repository / ".cz.toml").write_text("\n".join(lines) + "\n")
  history = "## 1.0.0 (2026-01-01)\n\n### Feat\n\n- Initial release\n\n## 0.9.0 (2025-12-01)\n\n- Archived release whose tag is missing\n"
  (repository / "CHANGELOG.md").write_text(history)

  def commit(message: str, tag: str = "") -> None:
    subprocess.run(["git", "commit", "--allow-empty", "-qm", message], cwd=repository, check=True)
    if tag:
      subprocess.run(["git", "tag", tag], cwd=repository, check=True)

  def generate(version: str) -> str:
    result = subprocess.run(
      ["bash", "-c", action_script("prepare-release", "Generate changelog")],
      cwd=repository,
      env={
        **os.environ,
        "VERSION": version,
        "PATH": str(Path(sys.executable).parent) + os.pathsep + os.environ["PATH"],
      },
      text=True,
      capture_output=True,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    return (repository / "CHANGELOG.md").read_text()

  commit("feat: add an example capability", "1.1.0-rc.1")
  commit("fix: repair the example capability", head_tag)
  rolled_up = generate("1.1.0")
  assert rolled_up.startswith("## 1.1.0 (")
  assert "-rc." not in rolled_up
  assert "- add an example capability" in rolled_up
  assert "- repair the example capability" in rolled_up
  assert rolled_up.endswith(history)

  # Final release runs the same action after a release PR already prepared it.
  assert generate("1.1.0") == rolled_up
  commit("fix: include an example review change")
  rolled_up = generate("1.1.0")
  assert "- include an example review change" in rolled_up
  assert rolled_up.count("## 1.1.0 (") == 1

  subprocess.run(["git", "tag", "1.1.0"], cwd=repository, check=True)
  commit("fix: preserve an example setting")
  next_release = generate("1.1.1")
  assert next_release.startswith("## 1.1.1 (")
  assert next_release.endswith(rolled_up)
  assert next_release.count("- add an example capability") == 1


def test_prepare_release_validates_stable_input_before_writing_files() -> None:
  data = yaml.safe_load((ROOT / ".github/actions/prepare-release/action.yml").read_text())
  first_step = data["runs"]["steps"][0]
  assert "continue-on-error" not in first_step
  assert first_step["uses"] == "./.github/actions/validate-release-tag"
  assert first_step["with"] == {
    "version": "${{ inputs.version }}",
    "allow_prerelease": "${{ inputs.allow_prerelease }}",
  }


def test_finalization_does_not_delete_git_tags() -> None:
  workflow = yaml.safe_load((ROOT / ".github/workflows/release-finalize.yml").read_text())
  for job in workflow["jobs"].values():
    for step in job.get("steps", []):
      script = step.get("run", "")
      assert not re.search(r"gh\s+api[^\n]*(?:-X|--method)\s+DELETE[^\n]*git/refs/tags", script)
      assert not re.search(r"git\s+push[^\n]*(?:--delete|:refs/tags/)", script)


@pytest.mark.parametrize(
  ("version", "valid"),
  [
    ("1.1.0", True),
    ("v1.1.0", True),
    ("1.1.0-rc.1", False),
    ("1.1.0-dev.1", False),
    ("1.1.0-hotfix.1", False),
    ("canary", False),
    ("01.1.0", False),
    ("", False),
  ],
)
def test_release_post_rejects_prereleases_before_producing_metadata(
  repository: Path, version: str, valid: bool,
) -> None:
  workflow = yaml.safe_load((ROOT / ".github/workflows/docs-release.yml").read_text())
  steps = workflow["jobs"]["create-release-post"]["steps"]
  script = next(step["run"] for step in steps if step.get("id") == "meta")
  output = repository / "outputs"
  result = subprocess.run(
    ["bash", "-c", script],
    cwd=repository,
    env={**os.environ, "NEW_VERSION": version, "GITHUB_OUTPUT": str(output)},
    text=True,
    capture_output=True,
  )
  assert (result.returncode == 0) is valid, result.stdout + result.stderr
  if valid:
    values = dict(line.split("=", 1) for line in output.read_text().splitlines())
    assert values["new_version"] == version.removeprefix("v")
  else:
    assert not output.exists()


@pytest.mark.parametrize(
  ("version", "valid"),
  [
    ("1.1.0-rc.2", True),
    ("1.1.0-rc.1", False),
    ("1.1.0-rc.0", False),
    ("1.1.0-rc.01", False),
    ("1.0.1-hotfix.2", True),
    ("1.0.1-hotfix.1", False),
    ("1.1.0", True),
    ("1.0.0-rc.2", False),
    ("0.9.0-hotfix.2", False),
    ("1.1.0-dev.1", False),
    ("canary", False),
    ("1.1.0-rc.2; exit 0", False),
  ],
)
def test_manual_promotion_accepts_increasing_rc_and_hotfix_tags(
  repository: Path, version: str, valid: bool,
) -> None:
  for tag in ("1.1.0-rc.1", "1.0.1-hotfix.1"):
    subprocess.run(["git", "tag", tag], cwd=repository, check=True)
  result = subprocess.run(
    ["bash", "-c", action_script("validate-release-tag", "Validate version")],
    cwd=repository,
    env={**os.environ, "VERSION": version, "BASE_VERSION": "", "SUFFIX_TYPE": "", "ALLOW_PRERELEASE": "true"},
    text=True,
    capture_output=True,
  )
  assert (result.returncode == 0) is valid, result.stdout + result.stderr


@pytest.mark.parametrize("version", ["1.1.0-rc.2", "1.0.1-hotfix.2"])
def test_candidate_preparation_preserves_changelog(repository: Path, version: str) -> None:
  path = repository / "CHANGELOG.md"
  history = "## 1.0.0 (2026-01-01)\n\n- Existing release history\n"
  path.write_text(history)
  result = subprocess.run(
    ["bash", "-c", action_script("prepare-release", "Generate changelog")],
    cwd=repository,
    env={**os.environ, "VERSION": version},
    text=True,
    capture_output=True,
  )
  assert result.returncode == 0, result.stdout + result.stderr
  assert path.read_text() == history


def test_manual_candidates_bypass_stable_release_and_post_requirements() -> None:
  workflow = yaml.safe_load((ROOT / ".github/workflows/release-manual.yml").read_text())
  jobs = workflow["jobs"]
  steps = jobs["commit-release"]["steps"]
  resolver = next(step for step in steps if step.get("id") == "channel")
  assert resolver["uses"] == "./.github/actions/determine-release-tag"
  assert resolver["with"]["manual_tag"] == "${{ env.RELEASE_VERSION }}"
  assert jobs["commit-release"]["outputs"]["is_final_release"] == "${{ steps.channel.outputs.is_final_release }}"
  assert jobs["publish-release"]["if"] == "needs.commit-release.outputs.is_final_release == 'true'"
  post = next(step for step in steps if "Require a release post" in step["name"])
  assert post["if"] == "steps.channel.outputs.is_final_release == 'true'"
  for step in steps:
    if step.get("uses") in ("./.github/actions/validate-release-tag", "./.github/actions/prepare-release"):
      assert step["with"]["allow_prerelease"] == "true"


@pytest.mark.parametrize("suffix", ["rc", "hotfix"])
def test_manual_candidate_suffix_cannot_move_backwards(repository: Path, suffix: str) -> None:
  subprocess.run(["git", "tag", f"1.1.0-{suffix}.5"], cwd=repository, check=True)
  result = subprocess.run(
    ["bash", "-c", action_script("validate-release-tag", "Validate version")],
    cwd=repository,
    env={**os.environ, "VERSION": f"1.1.0-{suffix}.4", "BASE_VERSION": "", "SUFFIX_TYPE": "", "ALLOW_PRERELEASE": "true"},
    text=True,
    capture_output=True,
  )
  assert result.returncode != 0
  assert "must be greater" in result.stdout


@pytest.mark.parametrize(
  ("event", "ref", "manual_tag", "build_all", "shared", "expected"),
  [
    ("workflow_dispatch", "refs/heads/main", "", False, False, ["primary"]),
    ("workflow_dispatch", "refs/heads/main", "1.1.0-rc.2", False, False, ["primary", "secondary"]),
    ("workflow_dispatch", "refs/heads/main", "1.1.0", False, False, ["primary", "secondary"]),
    ("workflow_dispatch", "refs/heads/main", "", True, False, ["primary", "secondary"]),
    ("push", "refs/heads/main", "", False, False, ["primary"]),
    ("push", "refs/tags/1.1.0-rc.2", "", False, False, ["primary", "secondary"]),
    ("pull_request", "refs/pull/1/merge", "", False, True, ["primary", "secondary"]),
  ],
)
def test_mcp_matrix_uses_explicit_manual_version(
  event: str, ref: str, manual_tag: str, build_all: bool, shared: bool, expected: list[str],
) -> None:
  workflow = yaml.safe_load((ROOT / ".github/workflows/ci-mcp-servers.yml").read_text())
  steps = workflow["jobs"]["determine-agents"]["steps"]
  step = next(step for step in steps if step.get("id") == "set-matrix")
  assert step["env"]["MANUAL_TAG_VERSION"] == "${{ inputs.tag_version }}"
  script = step["with"]["script"].replace("${{ github.event_name }}", event)
  result = subprocess.run(
    ["node", "-e", "const core = {setOutput: (key, value) => console.log(JSON.stringify({key, value}))};\n" + script],
    env={
      **os.environ,
      "ALL_AGENTS": json.dumps(["primary", "secondary"]),
      "FILTER_OUTPUTS": json.dumps({"primary": "true", "secondary": "false", "shared_config": str(shared).lower()}),
      "GITHUB_REF": ref,
      "TAG_VERSION": "canary",
      "MANUAL_TAG_VERSION": manual_tag,
      "MANUAL_BUILD_ALL": str(build_all).lower(),
    },
    text=True,
    capture_output=True,
    check=True,
  )
  outputs = dict(
    (item["key"], item["value"])
    for line in result.stdout.splitlines() if line.startswith("{")
    for item in [json.loads(line)]
  )
  assert json.loads(outputs["agents_to_build"]) == expected
  assert outputs["should_build"] == "true"
