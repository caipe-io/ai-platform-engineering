"""Release blog selection and release-body wiring regression tests."""
from __future__ import annotations

import json
import os
import runpy
import subprocess
import sys
import textwrap
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "resolve_release_blog.py"
resolve_release_blog = runpy.run_path(str(SCRIPT))["resolve_release_blog"]


def post(directory: Path, version: str, slug: str, extension: str = "md") -> Path:
    path = directory / f"2026-01-01-release-{version.replace('.', '-')}.{extension}"
    path.write_text(f"---\nslug: {slug}\ntitle: Example release\n---\n\n## Highlights\nExample changes.\n", encoding="utf-8")
    return path


@pytest.mark.parametrize("slug", ["release-1-3-4", '"release-1-3-4"', "'release-1-3-4'"])
def test_exact_patch_uses_its_authored_slug_before_the_series_post(tmp_path: Path, slug: str) -> None:
    post(tmp_path, "1.3.0", "release-1.3.0")
    post(tmp_path, "1.3.3", "release-1-3-3")
    post(tmp_path, "1.3.4", slug)
    assert resolve_release_blog(tmp_path, "1.3.4") == {"version": "1.3.4", "url": "https://caipe.io/releases/release-1-3-4"}


def test_series_fallback_preserves_legacy_dotted_slug(tmp_path: Path) -> None:
    post(tmp_path, "1.3.0", "release-1.3.0")
    post(tmp_path, "1.3.3", "release-1-3-3")
    assert resolve_release_blog(tmp_path, "1.3.5")["url"] == "https://caipe.io/releases/release-1.3.0"


def test_mdx_and_rc_use_the_base_patch_post(tmp_path: Path) -> None:
    post(tmp_path, "1.3.4", "release-1-3-4", "mdx")
    assert resolve_release_blog(tmp_path, "1.3.4-rc.1")["url"].endswith("/release-1-3-4")


def test_missing_stable_post_fails_but_rc_omits_the_link(tmp_path: Path) -> None:
    post(tmp_path, "1.2.0", "release-1-2-0")
    with pytest.raises(ValueError, match="No release post"):
        resolve_release_blog(tmp_path, "1.3.4")
    assert resolve_release_blog(tmp_path, "1.3.4-rc.1") == {"version": "", "url": ""}


@pytest.mark.parametrize("slug", ["https://example.test/notes", "../notes", '"release-1-3-4', "release-1-3-4'", "release 1-3-4"])
def test_rejects_invalid_or_mismatched_slug_quotes(tmp_path: Path, slug: str) -> None:
    post(tmp_path, "1.3.4", slug)
    with pytest.raises(ValueError, match="slug"):
        resolve_release_blog(tmp_path, "1.3.4")


def test_rejects_ambiguous_or_draft_posts(tmp_path: Path) -> None:
    path = post(tmp_path, "1.3.4", "release-1-3-4")
    duplicate = post(tmp_path, "1.3.4", "release-1-3-4", "mdx")
    with pytest.raises(ValueError, match="Multiple"):
        resolve_release_blog(tmp_path, "1.3.4")
    duplicate.unlink()
    path.write_text(path.read_text().replace("title:", "draft: true\ntitle:"))
    with pytest.raises(ValueError, match="draft"):
        resolve_release_blog(tmp_path, "1.3.4")


@pytest.mark.parametrize("second_slug", ["release-1-3-5", "invalid/slug"])
def test_rejects_duplicate_slug_keys_even_if_one_value_is_invalid(tmp_path: Path, second_slug: str) -> None:
    path = post(tmp_path, "1.3.4", "release-1-3-4")
    path.write_text(path.read_text().replace("title:", f"slug: {second_slug}\ntitle:"))
    with pytest.raises(ValueError, match="exactly one"):
        resolve_release_blog(tmp_path, "1.3.4")


@pytest.mark.parametrize("draft", ["true # awaiting publication", "True # awaiting publication", "TRUE"])
def test_rejects_draft_flags_with_comments(tmp_path: Path, draft: str) -> None:
    path = post(tmp_path, "1.3.4", "release-1-3-4")
    path.write_text(path.read_text().replace("title:", f"draft: {draft}\ntitle:"))
    with pytest.raises(ValueError, match="draft"):
        resolve_release_blog(tmp_path, "1.3.4")


@pytest.mark.parametrize("version", ["1.3", "1.3.4\nurl=invalid", "01.3.4", "../../notes", "1.3.4;exit"])
def test_rejects_invalid_release_versions(tmp_path: Path, version: str) -> None:
    with pytest.raises(ValueError, match="version"):
        resolve_release_blog(tmp_path, version)


def test_cli_emits_the_validated_job_outputs(tmp_path: Path) -> None:
    post(tmp_path, "1.3.4", "release-1-3-4")
    output = tmp_path / "outputs"
    subprocess.run([sys.executable, str(SCRIPT), "1.3.4", "--releases-dir", str(tmp_path), "--github-output", str(output)], check=True, capture_output=True, text=True)
    assert output.read_text() == "version=1.3.4\nurl=https://caipe.io/releases/release-1-3-4\n"


@pytest.mark.parametrize("version,slug", [("1.3.4", "release-1-3-4"), ("1.3.0", "release-1.3.0"), ("", "")])
def test_actual_release_body_uses_the_preflight_outputs(version: str, slug: str) -> None:
    workflow = (ROOT / ".github/workflows/release-manual.yml").read_text()
    assert "release_notes_url: ${{ steps.release-post.outputs.url }}" in workflow
    assert "RELEASE_NOTES_URL: ${{ needs.commit-release.outputs.release_notes_url }}" in workflow
    assert "RELEASE_NOTES_VERSION: ${{ needs.commit-release.outputs.release_notes_version }}" in workflow
    block = workflow.split('          NOTES="<!-- release-initiator:', 1)[1].split("          gh release create", 1)[0]
    shell = 'NOTES="<!-- release-initiator:' + block + '\nprintf "%s" "$NOTES"'
    url = f"https://caipe.io/releases/{slug}" if slug else ""
    env = {**os.environ, "RELEASE_INITIATOR": "example-actor", "RELEASE_NOTES_URL": url, "RELEASE_NOTES_VERSION": version}
    result = subprocess.run(["bash", "-euc", shell], env=env, check=True, capture_output=True, text=True)
    assert "<!-- release-initiator:example-actor -->" in result.stdout
    if url:
        assert f"[{version} release notes]({url})" in result.stdout
    else:
        assert "Release notes:" not in result.stdout


@pytest.mark.parametrize(
    "body,curl_status,is_draft,should_publish,should_probe",
    [
        ("📖 Release notes: [1.3.4 release notes](https://caipe.io/releases/release-1-3-4)", 0, True, True, True),
        ("📖 Release notes: [1.3.4 release notes](https://caipe.io/releases/release-1-3-4)", 22, True, False, True),
        ("<!-- release-initiator:example-actor -->\r\n\r\n📖 Release notes: [1.3.0 release notes](https://caipe.io/releases/release-1.3.0)\r\n", 0, True, True, True),
        ("No documentation link", 0, True, False, False),
        ("📖 Release notes: [1.3.4 release notes](https://example.test/releases/release-1-3-4)", 0, True, False, False),
        ("📖 Release notes: [1.3.4 release notes](https://caipe.io/releases/release-1-3-4)\n" * 2, 0, True, False, False),
        ("Already published", 0, False, False, False),
    ],
)
def test_finalize_only_publishes_after_the_link_is_available(
    tmp_path: Path, body: str, curl_status: int, is_draft: bool, should_publish: bool, should_probe: bool,
) -> None:
    workflow = (ROOT / ".github/workflows/release-finalize.yml").read_text()
    step = workflow.split("      - name: 🚀 Publish release\n", 1)[1].split("      - name:", 1)[0]
    shell = textwrap.dedent(step.split("        run: |\n", 1)[1]).replace("${{ github.repository }}", "example/example")
    fixture = tmp_path / "release.json"
    fixture.write_text(json.dumps({"isDraft": is_draft, "body": body, "url": "https://example.test/release"}))
    gh = tmp_path / "gh"
    gh.write_text('#!/bin/bash\nset -eu\ncase "$1 $2" in\n  "release view") cat "$RELEASE_FIXTURE";;\n  "release edit") printf "%s\\n" "$*" >> "$PUBLISH_LOG";;\n  *) exit 2;;\nesac\n')
    gh.chmod(0o755)
    curl = tmp_path / "curl"
    curl.write_text('#!/bin/bash\nprintf "%s\\n" "$@" > "$CURL_LOG"\nexit "$CURL_STATUS"\n')
    curl.chmod(0o755)
    output = tmp_path / "outputs"
    published = tmp_path / "published"
    probe = tmp_path / "probe"
    env = {
        **os.environ, "PATH": f"{tmp_path}:{os.environ['PATH']}", "TAG": "1.3.4", "GITHUB_OUTPUT": str(output),
        "RELEASE_FIXTURE": str(fixture), "PUBLISH_LOG": str(published), "CURL_LOG": str(probe), "CURL_STATUS": str(curl_status),
    }
    result = subprocess.run(["bash", "-euc", shell], env=env, capture_output=True, text=True)
    assert published.exists() == should_publish, result.stderr
    assert probe.exists() == should_probe
    assert (output.read_text() if output.exists() else "") == ("published=true\n" if should_publish else "")
    assert (result.returncode == 0) == (should_publish or not is_draft), result.stderr
    if should_probe:
        assert probe.read_text().splitlines()[-1].startswith("https://caipe.io/releases/")
    assert "if: steps.publish-release.outputs.published == 'true'" in workflow
    assert "PUBLISHED: ${{ steps.publish-release.outputs.published }}" in workflow
