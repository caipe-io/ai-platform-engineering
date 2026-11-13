"""Evidence gates for the opt-in, three-pass CLI research workflow."""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field


class CoverageItem(BaseModel):
    model_config = ConfigDict(extra="forbid")
    path: str = Field(min_length=1)
    status: Literal["reviewed", "not_reviewed"]
    evidence: str = Field(min_length=1)


class ResearchReport(BaseModel):
    model_config = ConfigDict(extra="forbid")
    complete: bool
    head_sha: str | None = Field(pattern=r"^[a-f0-9]{40}$")
    coverage: list[CoverageItem] = Field(min_length=1)
    checks: list[str] = Field(min_length=1)
    limitations: list[str]
    report_markdown: str = Field(min_length=80)


class PassUsage(BaseModel):
    num_turns: int = Field(ge=1, strict=True)
    total_cost_usd: float = Field(ge=0, allow_inf_nan=False)


PASSES = (
    ("Investigate", """Investigate the user's task. Make a plan, fetch authoritative sources, and inspect
the actual implementation. Obtain the PR metadata (get), current head SHA, complete paginated
changed-file list (get_files), and diff (get_diff),
read the diff and relevant surrounding code at that SHA, and build a per-file coverage checklist.
Treat descriptions and prior review comments as claims to verify, not findings to repeat.
Recover every saved large tool output with research.read_artifact, following next_offset until
null. This decodes JSON wrappers and pages long lines; native Read alone may truncate them.
never send workspace paths to a remote repository tool. Do not issue a final review yet.
End this pass with evidence, coverage gaps, and hypotheses for the next pass."""),
    ("Challenge", """Challenge the investigation in this same session. Perform additional source/tool
inspection: examine callers, authorization boundaries, compatibility, and relevant tests; seek
counterexamples to each proposed finding. Close coverage gaps and read saved large-output
artifacts completely with research.read_artifact. Re-fetch PR metadata (get) to recheck the head;
disclose any change rather than mixing revisions.
Do not claim a test ran unless a tool actually executed it. No posting, edits, or external
mutations. End with verified findings, rejected hypotheses, and outstanding limitations."""),
    ("Report", """Produce the final research report in the required JSON schema. For a PR, include
the inspected 40-character head SHA and one coverage entry for EVERY changed file. Mark any
uninspected file not_reviewed with the reason; set complete=false if coverage is incomplete.
List checks actually performed, distinguishing tests inspected from tests executed. Include
only evidence-backed findings with source links, paths/lines, concrete triggers and effects;
explicitly say when no finding was confirmed. List limitations and unresolved uncertainty.
Do not turn another reviewer's comment into a verified finding without checking the source.
Put the human-readable report in report_markdown. Never claim exhaustive verification."""),
)


@dataclass
class ResearchEvidence:
    workspace: Path
    phase: str = ""
    calls: dict[str, tuple[str, dict[str, Any]]] = field(default_factory=dict)
    successful: dict[str, int] = field(default_factory=dict)
    overflow: set[str] = field(default_factory=set)
    accessed: set[str] = field(default_factory=set)
    heads: set[str] = field(default_factory=set)
    head_phases: set[str] = field(default_factory=set)
    file_count: int | None = None
    files: set[str] = field(default_factory=set)
    targets: set[tuple[str, str, int]] = field(default_factory=set)
    diff_seen: bool = False
    expected_target: tuple[str, str, int] | None = None
    ranges: dict[str, list[tuple[int, int]]] = field(default_factory=dict)
    artifact_hashes: dict[str, str] = field(default_factory=dict)

    def capture(self, value: Any, method: str, depth: int = 0) -> None:
        if depth > 6:
            return
        if isinstance(value, str):
            try:
                self.capture(json.loads(value), method, depth + 1)
            except (ValueError, TypeError):
                pass
        elif isinstance(value, list):
            for item in value:
                self.capture(item, method, depth + 1)
        elif isinstance(value, dict):
            if method == "get" and isinstance(value.get("head"), dict):
                sha = value["head"].get("sha")
                if isinstance(sha, str) and re.fullmatch(r"[a-f0-9]{40}", sha):
                    self.heads.add(sha)
                    self.head_phases.add(self.phase)
                if isinstance(value.get("changed_files"), int):
                    self.file_count = value["changed_files"]
            if method == "get_files" and isinstance(value.get("filename"), str):
                self.files.add(value["filename"])
            for key in ("text", "content", "result"):
                if key in value:
                    self.capture(value[key], method, depth + 1)

    def artifact_receipt(self, content: Any) -> None:
        if isinstance(content, str):
            try:
                self.artifact_receipt(json.loads(content))
            except ValueError:
                pass
        elif isinstance(content, list):
            for block in content:
                self.artifact_receipt(block)
        elif isinstance(content, dict):
            if "artifact_path" in content:
                path, digest = content["artifact_path"], content["sha256"]
                if path in self.artifact_hashes and self.artifact_hashes[path] != digest:
                    self.accessed.discard(path)
                    self.ranges[path] = []
                self.artifact_hashes[path] = digest
                self.ranges.setdefault(path, []).append((content["offset"], content["end_offset"]))
                end = 0
                for start, stop in sorted(self.ranges[path]):
                    if start > end:
                        break
                    end = max(end, stop)
                if end == content["total_chars"]:
                    self.accessed.add(path)
            elif "text" in content:
                self.artifact_receipt(content["text"])

    def result(self, call_id: str, content: Any, failed: bool) -> None:
        call = self.calls.pop(call_id, None)
        if call is None or failed:
            return
        name, args = call
        if name.startswith(("mcp__caipe__", "mcp__research__")) or name in {"Read", "Grep", "Glob"}:
            self.successful[self.phase] = self.successful.get(self.phase, 0) + 1
        if name == "mcp__research__read_artifact":
            self.artifact_receipt(content)
        text = content if isinstance(content, str) else str(content)
        method = args.get("method", "") if name.startswith("mcp__caipe__") else ""
        if method in {"get", "get_files", "get_diff"} and all(key in args for key in ("owner", "repo", "pullNumber")):
            self.targets.add((args["owner"], args["repo"], args["pullNumber"]))
            self.capture(content, method)
            self.diff_seen = self.diff_seen or method == "get_diff"
        if "persisted-output" in text or "Output has been saved to" in text:
            for path in re.findall(r"/[^\s\"'<>]+/tool-results/[^\s\"'<>]+", text):
                candidate = Path(path.rstrip(".,:;)"))
                if candidate.resolve().is_relative_to(self.workspace):
                    self.overflow.add(str(candidate.resolve()))
                    # Inspect only bounded, workspace-local saved MCP metadata.
                    # This is an execution receipt, not credit for a model Read.
                    if method and candidate.is_file() and candidate.stat().st_size <= 16 * 1024 * 1024:
                        self.capture(candidate.read_text(errors="replace"), method)

    def rejection(self, report: ResearchReport) -> str | None:
        if any(not self.successful.get(phase) for phase in ("Investigate", "Challenge")):
            return "Investigation and challenge must each include successful source inspection."
        if self.overflow - self.accessed:
            return "Some saved large-output artifacts were not read; evidence coverage is incomplete."
        if len(self.targets) != 1 or len(self.heads) != 1 or not {"Investigate", "Challenge"} <= self.head_phases:
            return "A single unchanged PR head must be fetched in both investigation and challenge."
        if self.expected_target is not None and self.targets != {self.expected_target}:
            return "The inspected PR does not match the requested PR URL."
        if not self.diff_seen:
            return "The PR diff was not successfully fetched."
        if report.head_sha not in self.heads:
            return "The report does not match the PR head observed by the tools."
        if self.file_count is None or len(self.files) != self.file_count or {item.path for item in report.coverage} != self.files:
            return "The report must account for the complete changed-file inventory returned by the PR tools."
        if not report.complete or any(item.status != "reviewed" for item in report.coverage):
            return "The report declares incomplete source coverage."
        return None
