"""Contract check: manual prerelease builds must not move the stable `latest` tag."""

import re
from pathlib import Path

import yaml


WORKFLOW = Path(__file__).resolve().parents[1] / ".github/workflows/ci-caipe-ui.yml"
EVENT_REF = {
    "manual-stable": ("workflow_dispatch", "refs/heads/main", "1.2.3"),
    "manual-prerelease": ("workflow_dispatch", "refs/heads/main", "1.2.3-hotfix.1"),
    "tag-stable": ("push", "refs/tags/1.2.3", "1.2.3"),
    "tag-rc": ("push", "refs/tags/1.2.3-rc.1", "1.2.3-rc.1"),
}
EXPECTED = {
    "manual-stable": True,
    "manual-prerelease": False,
    "tag-stable": True,
    "tag-rc": False,
}


def _latest_enable_expressions() -> list[str]:
    text = WORKFLOW.read_text()
    yaml.safe_load(text)
    return re.findall(r"type=raw,value=latest,enable=\$\{\{ (.*?) \}\}\n", text)


def _evaluate(expr: str, event: str, ref: str, tag: str) -> bool:
    """Evaluate the GitHub expression subset used by the latest-tag rule."""
    ref_name = ref.rsplit("/", 1)[-1]
    py = expr.replace("github.event_name", repr(event))
    py = py.replace("github.ref_name", repr(ref_name)).replace("github.ref", repr(ref))
    py = py.replace("needs.determine-changes.outputs.tag_version", repr(tag))
    py = re.sub(r"startsWith\(([^,]+), ('[^']*')\)", r"\1.startswith(\2)", py)
    py = re.sub(r"contains\(([^,]+), ('[^']*')\)", r"(\2 in \1)", py)
    py = py.replace("&&", " and ").replace("||", " or ")
    py = re.sub(r"!(?!=)", " not ", py)
    return bool(eval(py))  # noqa: S307 - trusted, repo-owned expression


def test_both_metadata_blocks_use_latest_rule() -> None:
    exprs = _latest_enable_expressions()
    assert len(exprs) == 2
    assert exprs[0] == exprs[1]


def test_latest_tag_rule_per_trigger() -> None:
    for expr in _latest_enable_expressions():
        for case, (event, ref, tag) in EVENT_REF.items():
            assert _evaluate(expr, event, ref, tag) is EXPECTED[case], case
