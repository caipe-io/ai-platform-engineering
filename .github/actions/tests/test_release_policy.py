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
    ("1.1.0-rc.2", "", "", False),
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
    env={**os.environ, "VERSION": version, "BASE_VERSION": base, "SUFFIX_TYPE": suffix, "ALLOW_PRERELEASE": "false"},
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
    metadata_steps = [
      (job_name, step) for job_name, job in jobs.items() for step in job.get("steps", [])
      if step.get("uses", "").startswith("docker/metadata-action@")
    ]
    assert metadata_steps, path
    if path.name == "ci-mcp-servers.yml":
      assert {job_name for job_name, _ in metadata_steps} == {"build-and-push", "merge-manifests"}
    for job_name, step in metadata_steps:
      tags = step["with"]["tags"].splitlines()
      assert ("type=raw,value=latest,enable=${{ needs." + resolver_name + ".outputs.is_final_release == 'true' }}") in tags, (path, job_name)


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
  post = next(step for step in steps if step.get("id") == "release-post")
  assert post["if"] == "steps.channel.outputs.is_final_release == 'true'"
  for action in ("validate-release-tag", "prepare-release"):
    step = next(step for step in steps if step.get("uses") == f"./.github/actions/{action}")
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


@pytest.fixture
def release_cli(tmp_path: Path) -> Path:
  cli = tmp_path / "bin" / "gh"
  cli.parent.mkdir()
  cli.write_text(f"#!{sys.executable}\n" + '''
import json
import os
from pathlib import Path
import sys

args = sys.argv[1:]
entry = {"args": args}
if "--notes-file" in args:
    entry["notes"] = Path(args[args.index("--notes-file") + 1]).read_text()
with open(os.environ["CALLS"], "a") as calls:
    calls.write(json.dumps(entry) + "\\n")
if any("generate-notes" in arg for arg in args):
    if os.environ.get("FAIL_NOTES") == "true":
        sys.exit(1)
    print("* fix: repair example behavior (#12)")
elif args[0] == "api":
    if os.environ.get("FAIL_LIST") == "true":
        sys.exit(1)
    print(os.environ.get("EXISTING", ""))
else:
    print("https://github.com/example/project/releases/tag/1.1.0-rc.7")
''')
  cli.chmod(0o700)
  return cli.parent


@pytest.mark.parametrize(
  ("tag", "previous", "expected"),
  [("1.1.0-rc.1", [], "1.0.0"),
   ("1.1.0-rc.7", ["1.1.0-rc.1", "1.1.0-rc.6"], "1.1.0-rc.6"),
   ("1.1.0-rc.11", ["1.1.0-rc.2", "1.1.0-rc.9", "1.1.0-rc.10"], "1.1.0-rc.10"),
   ("1.1.0-rc.11", ["1.1.0-rc.010", "1.1.0-rc.9"], "1.1.0-rc.010"),
   ("1.1.0-rc.9999999999999999999999999999999999999", ["1.1.0-rc.9999999999999999999999999999999999998"], "1.1.0-rc.9999999999999999999999999999999999998")],
)
def test_rc_notes_use_explicit_baselines_and_exact_install_versions(
  repository: Path, release_cli: Path, tag: str, previous: list[str], expected: str,
) -> None:
  # Other series and future tags must never become the incremental baseline.
  for ref in [*previous, "1.0.1-rc.20", "2.0.0", "1.1.0-rc.99", tag]:
    subprocess.run(["git", "tag", ref], cwd=repository, check=True)
  calls = repository / "calls"
  subprocess.run(
    ["bash", "-c", action_script("publish-rc-release", "Publish candidate")],
    cwd=repository,
    env={**os.environ, "PATH": f"{release_cli}:{os.environ['PATH']}",
         "RC_TAG": tag, "GH_REPO": "example/project", "CALLS": str(calls)},
    check=True, capture_output=True, text=True,
  )
  entries = [json.loads(line) for line in calls.read_text().splitlines()]
  generate = next(entry["args"] for entry in entries if any("generate-notes" in arg for arg in entry["args"]))
  assert f"previous_tag_name={expected}" in generate
  assert f"tag_name={tag}" in generate
  publish = entries[-1]
  assert publish["args"][:3] == ["release", "create", tag]
  assert {"--verify-tag", "--prerelease", "--latest=false"} <= set(publish["args"])
  assert f"## Changes since {expected}" in publish["notes"]
  assert "* fix: repair example behavior (#12)" in publish["notes"]
  assert f"compare/1.0.0...{tag}" in publish["notes"]
  assert f"oci://ghcr.io/example/charts/ai-platform-engineering --version {tag}" in publish["notes"]
  assert f"docker pull ghcr.io/example/caipe-ui:{tag}" in publish["notes"]
  assert f"docker pull ghcr.io/example/caipe-dynamic-agents:{tag}" in publish["notes"]


@pytest.mark.parametrize(
  ("overrides", "success", "publication"),
  [({"EXISTING": "false"}, True, None),
   ({"EXISTING": "true"}, True, "edit"),
   ({"FAIL_NOTES": "true"}, False, None),
   ({"FAIL_LIST": "true"}, False, None),
   ({"RC_TAG": "1.1.0-dev.1"}, False, None),
   ({"RC_TAG": "1.1.0-hotfix.1"}, False, None)],
)
def test_rc_publication_preserves_published_notes_and_stops_on_api_errors(
  repository: Path, release_cli: Path, overrides: dict[str, str], success: bool, publication: str | None,
) -> None:
  subprocess.run(["git", "tag", "1.1.0-rc.7"], cwd=repository, check=True)
  calls = repository / "calls"
  result = subprocess.run(
    ["bash", "-c", action_script("publish-rc-release", "Publish candidate")],
    cwd=repository,
    env={**os.environ, "PATH": f"{release_cli}:{os.environ['PATH']}",
         "RC_TAG": "1.1.0-rc.7", "GH_REPO": "example/project", "CALLS": str(calls), **overrides},
    capture_output=True, text=True,
  )
  assert (result.returncode == 0) is success, result.stdout + result.stderr
  entries = [json.loads(line) for line in calls.read_text().splitlines()] if calls.exists() else []
  writes = [entry for entry in entries if entry["args"][0] == "release"]
  assert [entry["args"][1] for entry in writes] == ([publication] if publication else [])
  if overrides.get("EXISTING") == "false":
    assert not any("generate-notes" in arg for entry in entries for arg in entry["args"])
  if publication:
    assert {"--prerelease", "--latest=false", "--draft=false"} <= set(writes[0]["args"])


def test_rc_baselines_exclude_unrelated_branch_tags(repository: Path, release_cli: Path) -> None:
  subprocess.run(["git", "checkout", "-qb", "secondary"], cwd=repository, check=True)
  subprocess.run(["git", "commit", "--allow-empty", "-qm", "fix: unrelated change"], cwd=repository, check=True)
  for tag in ("1.0.1", "1.1.0-rc.6"):
    subprocess.run(["git", "tag", tag], cwd=repository, check=True)
  subprocess.run(["git", "checkout", "--detach", "1.0.0"], cwd=repository, check=True, capture_output=True)
  subprocess.run(["git", "tag", "1.1.0-rc.7"], cwd=repository, check=True)
  calls = repository / "calls"
  subprocess.run(
    ["bash", "-c", action_script("publish-rc-release", "Publish candidate")],
    cwd=repository,
    env={**os.environ, "PATH": f"{release_cli}:{os.environ['PATH']}",
         "RC_TAG": "1.1.0-rc.7", "GH_REPO": "example/project", "CALLS": str(calls)},
    check=True, capture_output=True,
  )
  assert "previous_tag_name=1.0.0" in calls.read_text()
  assert "compare/1.0.0...1.1.0-rc.7" in calls.read_text()


@pytest.mark.parametrize("status,conclusion,sha", [
  ("completed", "success", "a" * 40),
  ("completed", "failure", "a" * 40),
  ("in_progress", "", "a" * 40),
  ("completed", "skipped", "a" * 40),
  ("completed", "success", "b" * 40),
  ("missing", "", ""),
])
def test_rc_requires_successful_builds_for_its_exact_commit(
  tmp_path: Path, status: str, conclusion: str, sha: str,
) -> None:
  workflow = yaml.safe_load((ROOT / ".github/workflows/release-finalize.yml").read_text())
  job = workflow["jobs"]["check-and-publish"]
  steps = job["steps"]
  gate = next(step for step in steps if step.get("id") == "check-cis")
  script = gate["run"].replace("${{ github.repository }}", "example/project").replace("${{ github.server_url }}", "https://github.com")
  cli = tmp_path / "gh"
  cli.write_text(f"#!{sys.executable}\n" + '''
import json
import os
import sys
assert "--event=push" in sys.argv
run = {"status": os.environ["MOCK_RUN_STATUS"], "conclusion": os.environ["MOCK_RUN_CONCLUSION"],
       "databaseId": 123, "headSha": os.environ["MOCK_RUN_SHA"]}
if next(arg for arg in sys.argv if arg.startswith("--workflow=")) != "--workflow=[CI][Helm] Publish Tagged Helm Charts":
    run = {"status": "completed", "conclusion": "success", "databaseId": 124, "headSha": "a" * 40}
print(json.dumps([] if run["status"] == "missing" else [run]))
''')
  cli.chmod(0o700)
  output = tmp_path / "output"
  result = subprocess.run(
    ["bash", "-c", script],
    env={**os.environ, "PATH": f"{tmp_path}:{os.environ['PATH']}", "TAG": "1.1.0-rc.7",
         "EXPECTED_SHA": "a" * 40, "IS_RC": "true", "MOCK_RUN_STATUS": status,
         "MOCK_RUN_CONCLUSION": conclusion, "MOCK_RUN_SHA": sha, "GITHUB_OUTPUT": str(output)},
    capture_output=True, text=True,
  )
  assert result.returncode == 0, result.stdout + result.stderr
  passed = status == "completed" and conclusion == "success" and sha == "a" * 40
  assert f"all_passed={str(passed).lower()}\n" in output.read_text()
  publisher = next(step for step in steps if step.get("uses") == "./.github/actions/publish-rc-release")
  assert publisher["if"] == "steps.check-cis.outputs.all_passed == 'true' && steps.payload.outputs.is_rc == 'true'"
  stable = next(step for step in steps if step.get("id") == "publish-release")
  assert "is_rc == 'false'" in stable["if"]
  assert "cancel-in-progress: false" in (ROOT / ".github/workflows/release-finalize.yml").read_text()


def test_stable_release_notes_ignore_published_rc_boundaries(repository: Path, release_cli: Path) -> None:
  for tag in ("1.0.1", "1.1.0-rc.1", "1.1.0-rc.7"):
    subprocess.run(["git", "tag", tag], cwd=repository, check=True)
  (repository / "pyproject.toml").write_text('version = "1.1.0-rc.7"\n')
  workflow = yaml.safe_load((ROOT / ".github/workflows/release-manual.yml").read_text())
  read_step = next(step for step in workflow["jobs"]["commit-release"]["steps"] if step.get("id") == "validate")
  output = repository / "output"
  subprocess.run(
    ["bash", "-c", read_step["run"]], cwd=repository,
    env={**os.environ, "GITHUB_OUTPUT": str(output)}, check=True, capture_output=True,
  )
  values = dict(line.split("=", 1) for line in output.read_text().splitlines())
  assert values["previous_stable"] == "1.0.1"
  assert workflow["jobs"]["commit-release"]["outputs"]["previous_stable"] == "${{ steps.validate.outputs.previous_stable }}"
  publish = next(step for step in workflow["jobs"]["publish-release"]["steps"] if "Create GitHub Release" in step.get("name", ""))
  assert publish["env"]["PREVIOUS_STABLE"] == "${{ needs.commit-release.outputs.previous_stable }}"
  calls = repository / "calls"
  subprocess.run(
    ["bash", "-c", publish["run"].replace("${{ github.repository }}", "example/project")],
    cwd=repository,
    env={**os.environ, "PATH": f"{release_cli}:{os.environ['PATH']}", "CALLS": str(calls),
         "RELEASE_VERSION": "1.1.0", "PREVIOUS_STABLE": values["previous_stable"], "RELEASE_INITIATOR": "test-user",
         "RELEASE_NOTES_URL": "https://example.test/releases/release-1-1-0", "RELEASE_NOTES_VERSION": "1.1.0"},
    check=True, capture_output=True,
  )
  args = json.loads(calls.read_text())["args"]
  assert args[args.index("--notes-start-tag") + 1] == "1.0.1"
  assert "--generate-notes" in args
  assert "--prerelease" not in args


@pytest.mark.parametrize("ref,accepted", [
  ("refs/heads/main", True),
  ("refs/heads/primary", False),
  ("refs/tags/1.1.0", False),
  ("refs/tags/1.1.0-rc.1", False),
])
def test_manual_release_rejects_non_main_dispatch_before_credentials(ref: str, accepted: bool) -> None:
  workflow = yaml.safe_load((ROOT / ".github/workflows/release-manual.yml").read_text())
  steps = workflow["jobs"]["commit-release"]["steps"]
  guard = next(step for step in steps if step.get("name") == "Validate manual release ref")
  token = next(step for step in steps if step.get("id") == "app-token")
  assert steps.index(guard) < steps.index(token)
  assert guard["env"]["DISPATCH_REF"] == "${{ github.ref }}"
  result = subprocess.run(["bash", "-c", guard["run"]], env={**os.environ, "DISPATCH_REF": ref}, capture_output=True)
  assert (result.returncode == 0) is accepted


@pytest.mark.parametrize("head,version,is_release", [
  ("release/0.9.1-hotfix", "0.9.1-hotfix.1", False),
  ("release/1.1.0-hotfix", "1.1.0-hotfix.1", False),
  ("release/1.1.0", "1.1.0-rc.1", True),
  ("primary", "1.1.0-rc.1", False),
])
def test_hotfix_merge_backs_do_not_prepare_an_older_stable_version(
  repository: Path, head: str, version: str, is_release: bool,
) -> None:
  (repository / "pyproject.toml").write_text(f'version = "{version}"\n')
  workflow = yaml.safe_load((ROOT / ".github/workflows/pr-version-bump.yml").read_text())
  steps = workflow["jobs"]["version-bump"]["steps"]
  check = next(step for step in steps if step.get("id") == "release-check")
  output = repository / "output"
  subprocess.run(
    ["bash", "-c", check["run"]], cwd=repository,
    env={**os.environ, "BASE_REF": "main", "HEAD_REF": head, "GITHUB_OUTPUT": str(output)},
    check=True, capture_output=True,
  )
  values = dict(line.split("=", 1) for line in output.read_text().splitlines())
  assert values["is_release_merge"] == str(is_release).lower()
  assert values["needs_prepare"] == str(is_release).lower()
  prepare = next(step for step in steps if step.get("uses") == "./.github/actions/prepare-release")
  assert "is_release_merge == 'true'" in prepare["if"]
  assert "needs_prepare == 'true'" in prepare["if"]


@pytest.mark.parametrize("subject,expected", [
  ("fix: merge release/1.1.0-hotfix (#12)", False),
  ("fix: merge release/1.1.0 (#12)", True),
  ("fix: merge release/1.1.0", True),
])
def test_squashed_hotfix_merge_does_not_dispatch_stable_promotion(repository: Path, subject: str, expected: bool) -> None:
  subprocess.run(["git", "commit", "--allow-empty", "-qm", subject], cwd=repository, check=True)
  workflow = yaml.safe_load((ROOT / ".github/workflows/auto-tag.yml").read_text())
  step = next(step for step in workflow["jobs"]["auto-tag"]["steps"] if step.get("id") == "release-merge")
  output = repository / "output"
  subprocess.run(
    ["bash", "-c", step["run"]], cwd=repository,
    env={**os.environ, "GITHUB_OUTPUT": str(output)}, check=True, capture_output=True,
  )
  assert f"is_release_merge={str(expected).lower()}\n" in output.read_text()


@pytest.mark.parametrize("suffix", ["rc", "hotfix"])
@pytest.mark.parametrize("number,existing,accepted", [
  ("10", ["010", "9"], False),
  ("11", ["010", "9"], True),
  ("9", ["08"], True),
  ("01", [], False),
  ("9999999999999999999999999999999999999", ["9999999999999999999999999999999999998"], True),
  ("9999999999999999999999999999999999998", ["9999999999999999999999999999999999999"], False),
])
def test_candidate_suffix_comparisons_are_decimal_and_do_not_overflow(
  repository: Path, suffix: str, number: str, existing: list[str], accepted: bool,
) -> None:
  for value in existing:
    subprocess.run(["git", "tag", f"1.1.0-{suffix}.{value}"], cwd=repository, check=True)
  result = subprocess.run(
    ["bash", "-c", action_script("validate-release-tag", "Validate version")], cwd=repository,
    env={**os.environ, "VERSION": f"1.1.0-{suffix}.{number}", "ALLOW_PRERELEASE": "true",
         "BASE_VERSION": "", "SUFFIX_TYPE": ""}, capture_output=True, text=True,
  )
  assert (result.returncode == 0) is accepted, result.stdout + result.stderr


def test_remote_tag_lookup_and_refresh_failures_stop_release_validation(repository: Path) -> None:
  subprocess.run(["git", "remote", "set-url", "origin", str(repository / "missing")], cwd=repository, check=True)
  result = subprocess.run(
    ["bash", "-c", action_script("validate-release-tag", "Fetch tags")],
    cwd=repository, capture_output=True,
  )
  assert result.returncode != 0
  result = subprocess.run(
    ["bash", "-c", action_script("validate-release-tag", "Validate version")], cwd=repository,
    env={**os.environ, "VERSION": "1.1.0-rc.2", "ALLOW_PRERELEASE": "true", "BASE_VERSION": "", "SUFFIX_TYPE": ""},
    capture_output=True, text=True,
  )
  assert result.returncode != 0
  assert "Cannot verify remote tag" in result.stderr
