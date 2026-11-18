"""Execute the pinned Docker action with local GitHub fixtures; never push images."""

import argparse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
from threading import Thread

import yaml


ROOT = Path(__file__).resolve().parents[3]
REPOSITORY = {
  "name": "project", "full_name": "example/project", "default_branch": "main",
  "html_url": "https://github.com/example/project", "description": "Example project",
  "owner": {"login": "example"},
}


class RepositoryAPI(BaseHTTPRequestHandler):
  def do_GET(self) -> None:
    if self.path != "/repos/example/project":
      self.send_error(404)
      return
    self.send_response(200)
    self.send_header("Content-Type", "application/json")
    self.end_headers()
    self.wfile.write(json.dumps(REPOSITORY).encode())

  def log_message(self, format: str, *args: object) -> None:
    pass


def render(value: str, ref: str, version: str, stable: bool, variant: str) -> str:
  substitutions = {
    r"needs\.[\w-]+\.outputs\.is_final_release == 'true'": str(stable).lower(),
    r"needs\.[\w-]+\.outputs\.tag_version != ''": str(bool(version)).lower(),
    r"needs\.[\w-]+\.outputs\.tag_version": version,
    r"github\.ref != 'refs/heads/main'": str(ref != "refs/heads/main").lower(),
  }
  for expression, replacement in substitutions.items():
    value = re.sub(r"\$\{\{ " + expression + r" \}\}", lambda _: replacement, value)
  value = value.replace("${{ matrix.variant != 'default' && format('-{0}', matrix.variant) || '' }}",
                        "" if variant == "default" else f"-{variant}")
  assert "${{" not in value, f"Unhandled workflow expression: {value}"
  return value


def action_tags(bundle: Path, api_url: str, event: str, ref: str, tags: str, flavor: str) -> list[str]:
  with tempfile.TemporaryDirectory() as directory:
    root = Path(directory)
    (root / "event.json").write_text(json.dumps({
      "repository": REPOSITORY,
      "head_commit": {"id": "a" * 40, "timestamp": "2026-01-01T00:00:00Z"},
    }))
    for filename in ("output", "state", "summary"):
      (root / filename).touch()
    env = {
      "PATH": os.environ["PATH"], "HOME": directory, "RUNNER_TEMP": directory,
      "GITHUB_WORKSPACE": directory, "GITHUB_REPOSITORY": "example/project",
      "GITHUB_API_URL": api_url, "GITHUB_REF": ref, "GITHUB_SHA": "a" * 40,
      "GITHUB_EVENT_NAME": event, "GITHUB_EVENT_PATH": str(root / "event.json"),
      "GITHUB_OUTPUT": str(root / "output"), "GITHUB_STATE": str(root / "state"),
      "GITHUB_STEP_SUMMARY": str(root / "summary"), "GITHUB_ACTOR": "test-user",
      "GITHUB_RUN_ID": "1", "GITHUB_RUN_NUMBER": "1", "DOCKER_METADATA_SET_OUTPUT_ENV": "false",
      "INPUT_IMAGES": "registry.example.test/example", "INPUT_GITHUB-TOKEN": "example-token",
      "INPUT_TAGS": tags, "INPUT_FLAVOR": flavor,
    }
    result = subprocess.run(["node", str(bundle)], env=env, capture_output=True, text=True, timeout=30)
    assert result.returncode == 0, result.stdout + result.stderr
    output = (root / "output").read_text().splitlines()
    index = next(i for i, line in enumerate(output) if line.startswith("json<<"))
    return json.loads(output[index + 1])["tags"]


def main() -> None:
  parser = argparse.ArgumentParser(description=__doc__)
  parser.add_argument("bundle", type=Path, help="dist/index.cjs from the pinned docker/metadata-action checkout")
  bundle = parser.parse_args().bundle.resolve()
  assert bundle.is_file(), bundle
  policy = yaml.safe_load((ROOT / ".github/workflows/release-policy-tests.yml").read_text())
  checkout = next(step for step in policy["jobs"]["test"]["steps"]
                  if step.get("with", {}).get("repository") == "docker/metadata-action")
  pin = checkout["with"]["ref"]
  server = ThreadingHTTPServer(("127.0.0.1", 0), RepositoryAPI)
  thread = Thread(target=server.serve_forever, daemon=True)
  thread.start()
  api_url = f"http://127.0.0.1:{server.server_port}"
  cache: dict[tuple[str, ...], list[str]] = {}
  checked = 0
  try:
    # Verify the old configuration really reproduces the implicit Latest leak.
    control = action_tags(bundle, api_url, "push", "refs/tags/1.1.0-rc.7",
                          "type=raw,value=latest,enable=false\ntype=ref,event=tag", "")
    assert "registry.example.test/example:latest" in control
    cases = [
      ("push", "refs/tags/1.1.0", "1.1.0", True),
      ("push", "refs/tags/1.1.0-rc.7", "1.1.0-rc.7", False),
      ("push", "refs/tags/1.1.0-dev.1", "1.1.0-dev.1", False),
      ("push", "refs/tags/1.1.0-hotfix.1", "1.1.0-hotfix.1", False),
      ("push", "refs/heads/main", "canary", False),
      ("workflow_dispatch", "refs/heads/main", "1.1.0-rc.7", False),
      ("workflow_dispatch", "refs/heads/main", "1.1.0", True),
      ("workflow_dispatch", "refs/heads/main", "canary", False),
      ("pull_request", "refs/pull/1/merge", "", False),
    ]
    for path in sorted((ROOT / ".github/workflows").glob("*.yml")):
      for job_name, job in yaml.safe_load(path.read_text()).get("jobs", {}).items():
        for step in job.get("steps", []):
          if not step.get("uses", "").startswith("docker/metadata-action@"):
            continue
          assert step["uses"] == f"docker/metadata-action@{pin}", (path, job_name)
          inputs = step["with"]
          assert "latest=false" in inputs.get("flavor", "").splitlines(), (path, job_name)
          if not path.name.startswith("ci-"):
            continue
          for event, ref, version, stable in cases:
            for variant in ("default", "secondary") if "matrix.variant" in inputs["flavor"] else ("default",):
              tags = render(inputs["tags"], ref, version, stable, variant)
              flavor = render(inputs["flavor"], ref, version, stable, variant)
              key = (event, ref, tags, flavor)
              if key not in cache:
                cache[key] = action_tags(bundle, api_url, event, ref, tags, flavor)
              actual = cache[key]
              assert any(tag.split(":")[-1].startswith("latest") for tag in actual) is stable, (path, job_name, key, actual)
              if version:
                suffix = "" if variant == "default" else f"-{variant}"
                assert f"registry.example.test/example:{version}{suffix}" in actual, (path, job_name, actual)
              checked += 1
    print(f"Verified {checked} workflow/channel cases using {len(cache)} distinct action executions; old RC configuration reproduced Latest.")
  finally:
    server.shutdown()
    server.server_close()
    thread.join()


if __name__ == "__main__":
  main()
