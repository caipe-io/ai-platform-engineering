#!/usr/bin/env python3
"""Resolve a release's documentation link from the selected post's slug."""

from __future__ import annotations

import argparse
import re
from pathlib import Path

VERSION_PATTERN = re.compile(r"(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-rc\.(0|[1-9][0-9]*))?")
SLUG_PATTERN = re.compile(
    r'''^slug:[ \t]*(?:"([a-zA-Z0-9][a-zA-Z0-9._-]*)"|'([a-zA-Z0-9][a-zA-Z0-9._-]*)'|([a-zA-Z0-9][a-zA-Z0-9._-]*))[ \t]*(?:#.*)?$''',
    re.MULTILINE,
)


def resolve_release_blog(releases_dir: Path, version: str) -> dict[str, str]:
    """Prefer the exact patch post, with the same minor's .0 post as fallback."""
    match = VERSION_PATTERN.fullmatch(version)
    if not match:
        raise ValueError("Expected a stable or RC release version, such as 1.3.4 or 1.3.4-rc.1")
    base = ".".join(match.group(index) for index in (1, 2, 3))
    series = f"{match.group(1)}.{match.group(2)}.0"
    for candidate in dict.fromkeys((base, series)):
        suffix = candidate.replace(".", "-")
        posts = sorted(releases_dir.glob(f"*release-{suffix}.md")) + sorted(releases_dir.glob(f"*release-{suffix}.mdx"))
        if not posts:
            continue
        if len(posts) != 1:
            raise ValueError(f"Multiple release posts found for {candidate}; keep one canonical post")
        post = posts[0]
        text = post.read_text(encoding="utf-8")
        frontmatter = re.match(r"\A---[ \t]*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)", text)
        slug_lines = re.findall(r"^slug[ \t]*:.*$", frontmatter.group(1), re.MULTILINE) if frontmatter else []
        slug = SLUG_PATTERN.fullmatch(slug_lines[0]) if len(slug_lines) == 1 else None
        if not slug:
            raise ValueError(f"{post}: set exactly one single-path slug in YAML frontmatter")
        if re.search(r"^draft:[ \t]*(?:true|True|TRUE)[ \t]*(?:#.*)?$", frontmatter.group(1), re.MULTILINE):
            raise ValueError(f"{post}: release notes must not be a draft")
        slug_value = next(value for value in slug.groups() if value is not None)
        return {"version": candidate, "url": f"https://caipe.io/releases/{slug_value}"}
    if match.group(4):
        return {"version": "", "url": ""}
    raise ValueError(f"No release post found for {base} or {series}; add it under {releases_dir} before tagging")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("version")
    parser.add_argument("--releases-dir", type=Path, default=Path(__file__).resolve().parents[1] / "docs" / "releases")
    parser.add_argument("--github-output", type=Path)
    args = parser.parse_args()
    try:
        result = resolve_release_blog(args.releases_dir, args.version)
    except (OSError, ValueError) as error:
        parser.exit(1, f"Release blog error: {error}\n")
    if args.github_output:
        with args.github_output.open("a", encoding="utf-8") as output:
            output.write(f"version={result['version']}\nurl={result['url']}\n")
    print(result["url"] or "Release candidate has no blog post yet; omitting the documentation link")


if __name__ == "__main__":
    main()
