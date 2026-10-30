"""Release blog selection and release-body wiring regression tests."""
from __future__ import annotations

import os
import runpy
import subprocess
import sys
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
