from __future__ import annotations

import asyncio
import json
import os
import sys
from pathlib import Path
from typing import Any

import pytest
from acp.schema import TextContentBlock
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

from harness_engine.adapters.claude_acp import ClaudeACPAdapter
from harness_engine.claude_cli_acp import ClaudeCodeCLIAgent
from harness_engine.claude_research import ResearchEvidence, ResearchReport
from harness_engine.claude_research_artifacts import read_artifact
from harness_engine.config import Settings
from tests.test_claude_cli_acp import FIXTURE, Updates, configured, policy, servers
from tests.test_claude_workers import context

SHA = "a" * 40


async def research_configured(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, *, max_turns: int = 12) -> tuple[ClaudeCodeCLIAgent, Updates, str]:
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(tmp_path / ".claude"))
    agent = ClaudeCodeCLIAgent([sys.executable, str(FIXTURE)])
    client = Updates()
    agent.on_connect(client)
    metadata = policy()
    metadata["claudeCode"]["options"].update(
        maxTurns=max_turns, research={}, researchPrTools=["mcp__caipe__tool_0"],
        allowedTools=["mcp__caipe__example_wait", "mcp__caipe__tool_0"],
    )
    session = await agent.new_session(str(tmp_path), servers(), **metadata)
    return agent, client, session.session_id


def report() -> ResearchReport:
    return ResearchReport(complete=True, head_sha=SHA,
                          coverage=[{"path": "example.py", "status": "reviewed", "evidence": "Inspected pinned diff."}],
                          checks=["Test source inspected, not executed."], limitations=["No test execution."],
                          report_markdown="Source-backed review with references and explicit limitations. " * 3)


def evidence(root: Path) -> ResearchEvidence:
    ledger = ResearchEvidence(root, pr_tools={"mcp__caipe__tool_0"})
    for phase in ("Investigate", "Challenge"):
        ledger.phase = phase
        ledger.calls[phase] = ("mcp__caipe__tool_0", {"method": "get", "owner": "example", "repo": "sample", "pullNumber": 1})
        ledger.result(phase, [{"type": "text", "text": json.dumps({"head": {"sha": SHA}, "changed_files": 1})}], False)
    ledger.calls["files"] = ("mcp__caipe__tool_0", {"method": "get_files", "owner": "example", "repo": "sample", "pullNumber": 1})
    ledger.result("files", [{"type": "text", "text": '[{"filename":"example.py"}]'}], False)
    ledger.diff_seen = True
    return ledger


def artifact(root: Path, name: str = "result.json") -> Path:
    path = root / ".claude" / "projects" / "example" / "session" / "tool-results" / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps([{"type": "text", "text": "α" * 25000 + "\\n"}]))
    return path


def test_decoded_pages_cover_long_json_lines_without_changing_literal_escapes(tmp_path: Path) -> None:
    path = artifact(tmp_path)
    pages = [read_artifact(tmp_path, str(path))]
    while pages[-1]["next_offset"] is not None:
        pages.append(read_artifact(tmp_path, str(path), pages[-1]["next_offset"]))
    assert "".join(page["text"] for page in pages) == "α" * 25000 + "\\n"
    assert all(len(json.dumps(page["text"])) <= 8000 for page in pages)
    ledger = evidence(tmp_path)
    ledger.overflow.add(str(path))
    assert ledger.rejection(report())
    ledger.artifact_receipt(pages[0])
    for page in pages[2:]:
        ledger.artifact_receipt(page)
    assert ledger.rejection(report())  # A gap cannot be claimed as complete.
    ledger.artifact_receipt([{"type": "text", "text": json.dumps(pages[1])}])
    assert ledger.rejection(report()) is None
    path.write_text('"replacement"')
    ledger.artifact_receipt(read_artifact(tmp_path, str(path), 1))
    assert ledger.rejection(report())  # A changed hash invalidates prior receipts.


@pytest.mark.parametrize("layout", ["single", "multiple", "split"])
@pytest.mark.parametrize("notice", ["<persisted-output>\nFull output saved to: ", "Error: result too large. Output has been saved to "])
def test_saved_artifact_paths_use_actual_text_blocks(tmp_path: Path, layout: str, notice: str) -> None:
    path = artifact(tmp_path)
    text = f"{notice}{path}\nPreview: truncated evidence"
    content = [{"type": "text", "text": text}]
    if layout == "multiple":
        content.append({"type": "text", "text": "Additional tool context"})
    elif layout == "split":
        content = [{"type": "text", "text": notice}, {"type": "text", "text": f"{path}\nPreview: truncated evidence"}]
    ledger = evidence(tmp_path)
    ledger.calls["overflow"] = ("mcp__caipe__tool_0", {})
    ledger.result("overflow", content, False)
    assert ledger.overflow == {str(path)}
    assert not ledger.unavailable_artifact
    assert ledger.rejection(report()) is not None
    offset = 0
    while True:
        page = read_artifact(tmp_path, str(path), offset)
        ledger.artifact_receipt(page)
        if page["next_offset"] is None:
            break
        offset = page["next_offset"]
    assert ledger.rejection(report()) is None


@pytest.mark.parametrize("kind", ["outside", "sibling", "symlink", "directory_symlink", "config"])
def test_artifact_reader_rejects_non_artifacts_and_other_workspaces(tmp_path: Path, kind: str) -> None:
    own = tmp_path / "own"
    target = artifact(tmp_path / "other")
    if kind == "outside":
        path = tmp_path / "secret.txt"
        path.write_text("private")
    elif kind == "sibling":
        path = target
    elif kind == "config":
        path = own / ".claude" / "projects" / "mcp.json"
        path.parent.mkdir(parents=True)
        path.write_text("private")
    elif kind == "symlink":
        path = artifact(own)
        path.unlink()
        path.symlink_to(target)
    else:
        path = own / ".claude" / "projects" / "alias" / "session" / "tool-results" / target.name
        path.parents[3].mkdir(parents=True)
        path.parents[2].symlink_to(target.parents[2], target_is_directory=True)
    with pytest.raises(ValueError):
        read_artifact(own, str(path))


@pytest.mark.parametrize(("offset", "limit"), [(-1, 1), (False, 1), (0, 12001), (0, 0), (99999, 1)])
def test_artifact_page_bounds(tmp_path: Path, offset: int, limit: int) -> None:
    with pytest.raises(ValueError):
        read_artifact(tmp_path, str(artifact(tmp_path)), offset, limit)


def test_directory_swap_cannot_redirect_an_artifact_open(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    root = tmp_path / "own"
    path = artifact(root)
    external = artifact(tmp_path / "other")
    original_open = os.open
    swapped = False

    def racing_open(name: object, flags: int, *args: object, **kwargs: object) -> int:
        nonlocal swapped
        if name == "tool-results" and not swapped:
            swapped = True
            path.parent.rename(path.parent.with_name("original-output"))
            path.parent.symlink_to(external.parent, target_is_directory=True)
        return original_open(name, flags, *args, **kwargs)

    monkeypatch.setattr(os, "open", racing_open)
    with pytest.raises(ValueError):
        read_artifact(root, str(path))
    assert swapped


async def test_real_stdio_artifact_tool_enforces_scope_and_returns_page_receipts(tmp_path: Path) -> None:
    path = artifact(tmp_path)
    server = StdioServerParameters(command=sys.executable,
                                   args=["-m", "harness_engine.claude_research_artifacts", "--root", str(tmp_path)],
                                   env={"PYTHONPATH": str(Path(__file__).resolve().parents[1] / "src")})
    async with stdio_client(server) as (reader, writer), ClientSession(reader, writer) as session:
        await session.initialize()
        assert [tool.name for tool in (await session.list_tools()).tools] == ["read_artifact"]
        result = await session.call_tool("read_artifact", {"path": str(path)})
        page = json.loads(result.content[0].text)
        assert page["artifact_path"] == str(path) and page["next_offset"] > 0
        assert len(page["text"]) < 12000
        rejected = await session.call_tool("read_artifact", {"path": "/proc/self/environ"})
        assert rejected.isError


@pytest.mark.parametrize("failure", ["no_challenge", "changed_head", "wrong_head", "missing_file", "extra_file", "incomplete"])
def test_report_cannot_self_certify_missing_or_conflicting_evidence(tmp_path: Path, failure: str) -> None:
    ledger, output = evidence(tmp_path), report()
    assert ledger.rejection(output) is None
    if failure == "no_challenge":
        ledger.successful.pop("Challenge")
    elif failure == "changed_head":
        ledger.heads.add("b" * 40)
    elif failure == "wrong_head":
        output.head_sha = "b" * 40
    elif failure == "missing_file":
        ledger.file_count = 2  # A missing pagination page is incomplete.
    elif failure == "extra_file":
        output.coverage[0].path = "not-in-pr.py"
    else:
        output.complete = False
    assert ledger.rejection(output)


def test_other_tools_cannot_spoof_authoritative_pr_metadata(tmp_path: Path) -> None:
    ledger = evidence(tmp_path)
    ledger.calls["spoof"] = ("mcp__caipe__other", {"method": "get", "owner": "other", "repo": "sample", "pullNumber": 2})
    ledger.result("spoof", {"head": {"sha": "b" * 40}, "changed_files": 99}, False)
    assert ledger.heads == {SHA} and ledger.file_count == 1
    assert ledger.targets == {("example", "sample", 1)}


async def test_three_pass_cli_uses_one_session_shared_budget_and_hides_unverified_answers(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    agent, client, session = await research_configured(tmp_path, monkeypatch)
    result = await agent.prompt(session, [TextContentBlock(type="text", text="research example")])
    assert result.stop_reason == "end_turn"
    calls = [json.loads(line) for line in (tmp_path / "research-calls.jsonl").read_text().splitlines()]
    assert len(calls) == 3
    assert "--session-id" in calls[0] and all("--resume" in call for call in calls[1:])
    assert [float(call[call.index("--max-budget-usd") + 1]) for call in calls] == pytest.approx([2.5, 1.5, 4.9])
    assert "--json-schema" in calls[-1] and "--json-schema" not in calls[0]
    messages = [event.content.text for event in client.events if event.session_update == "agent_message_chunk"]
    assert len(messages) == 1 and "Research execution: 3 passes; 6 model turns" in messages[0]
    assert not any("CLI answer" in message for message in messages)
    assert result.field_meta == {"caipe.io/harness": {"final_content": messages[0]}}
    assert agent.options["maxTurns"] == 12


@pytest.mark.parametrize("costs, released", [([4.0, 4.2, 4.4], True), ([4.0, 4.2, 5.1], False)])
async def test_restored_session_cost_is_charged_once_and_final_overrun_is_withheld(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, costs: list[float], released: bool) -> None:
    agent, client, session = await research_configured(tmp_path, monkeypatch)
    original = agent.run_prompt
    allowances = []

    async def run_prompt(*args):
        allowances.append(agent.pass_budget)
        response = await original(*args)
        agent.last_result["total_cost_usd"] = costs[len(allowances) - 1]
        return response

    monkeypatch.setattr(agent, "run_prompt", run_prompt)
    await agent.prompt(session, [TextContentBlock(type="text", text="research example")])
    assert allowances == pytest.approx([2.5, 1.0, 0.8])
    messages = [event.content.text for event in client.events if event.session_update == "agent_message_chunk"]
    assert len(messages) == 1
    assert ("Research execution:" in messages[0]) is released
    if not released:
        assert "cost budget was exhausted" in messages[0]


async def test_failed_verification_releases_only_an_incomplete_notice(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    agent, client, session = await research_configured(tmp_path, monkeypatch)
    await agent.prompt(session, [TextContentBlock(type="text", text="research no-evidence")])
    messages = [event.content.text for event in client.events if event.session_update == "agent_message_chunk"]
    assert len(messages) == 1 and messages[0].startswith("Research incomplete:")


async def test_investigation_turn_cap_preserves_budget_for_challenge_and_report(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    agent, client, session = await research_configured(tmp_path, monkeypatch)
    await agent.prompt(session, [TextContentBlock(type="text", text="research-capped")])
    messages = [event.content.text for event in client.events if event.session_update == "agent_message_chunk"]
    assert len(messages) == 1 and "Research execution: 3 passes; 10 model turns" in messages[0]


async def test_report_budget_failure_explains_the_limit_and_preserves_safe_usage_receipts(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    agent, client, session = await research_configured(tmp_path, monkeypatch)
    await agent.prompt(session, [TextContentBlock(type="text", text="research-cost-cap")])
    messages = [event.content.text for event in client.events if event.session_update == "agent_message_chunk"]
    assert len(messages) == 1 and "Report reached its CLI-reported cost allowance" in messages[0]
    usage = [event.content.text for event in client.events if event.session_update == "agent_thought_chunk" and "Research usage:" in event.content.text]
    assert len(usage) == 3 and '"stop": "error_max_budget_usd"' in usage[-1]


async def test_premature_complete_report_is_repaired_until_actual_artifact_receipt_arrives(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    agent, client, session = await research_configured(tmp_path, monkeypatch)
    await agent.prompt(session, [TextContentBlock(type="text", text="research-repair")])
    messages = [event.content.text for event in client.events if event.session_update == "agent_message_chunk"]
    assert len(messages) == 1 and "1/1 saved outputs fully paged" in messages[0]
    assert "report attempts: 2" in messages[0] and "8 model turns" in messages[0]
    calls = (tmp_path / "research-calls.jsonl").read_text().splitlines()
    assert len(calls) == 4


@pytest.mark.parametrize("denied", [False, True])
async def test_formatter_input_requires_successful_native_ack_before_fallback(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, denied: bool) -> None:
    agent, client, session = await research_configured(tmp_path, monkeypatch)
    await agent.prompt(session, [TextContentBlock(type="text", text="research-fallback" + ("-denied" if denied else ""))])
    messages = [event.content.text for event in client.events if event.session_update == "agent_message_chunk"]
    assert len(messages) == 1
    assert messages[0].startswith("Research incomplete:") is denied
    formatter = next(event for event in client.events if event.session_update == "tool_call" and event.title == "StructuredOutput")
    completed = next(event for event in client.events if event.session_update == "tool_call_update" and event.tool_call_id == formatter.tool_call_id)
    assert formatter.raw_input == {} and completed.raw_output is None
    assert completed.status == ("failed" if denied else "completed")
    tools = [event.model_dump(mode="json") for event in client.events if event.session_update.startswith("tool_call")]
    assert "Source-backed review" not in json.dumps(tools)


async def test_research_configuration_exposes_only_read_search_and_artifact_tools(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    original, _, _ = await configured(tmp_path, monkeypatch)
    agent = ClaudeCodeCLIAgent(original.command)
    metadata = policy()
    metadata["claudeCode"]["options"].update(maxTurns=12, research={})
    await agent.new_session(str(tmp_path), servers(), **metadata)
    assert agent.options["tools"] == ["Read", "Grep", "Glob"]
    assert "mcp__research__read_artifact" in agent.options["allowedTools"]
    assert agent.servers["research"]["args"][-1] == str(tmp_path)
    assert set(agent.servers) == {"caipe", "research"}


async def test_artifact_only_configuration_never_enables_native_filesystem_tools(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    original, _, _ = await configured(tmp_path, monkeypatch)
    agent = ClaudeCodeCLIAgent(original.command)
    metadata = policy()
    metadata["claudeCode"]["options"].update(maxTurns=12, research={}, researchArtifactsOnly=True)
    await agent.new_session(str(tmp_path), servers(), **metadata)
    assert agent.options["tools"] == []
    assert agent.options["allowedTools"] == ["mcp__caipe__example_wait", "mcp__research__read_artifact"]


@pytest.mark.parametrize("pr_tools", [["mcp__caipe__unapproved"], "mcp__caipe__example_wait"])
async def test_research_pr_aliases_must_be_in_the_configured_allowlist(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, pr_tools: object) -> None:
    monkeypatch.chdir(tmp_path)
    agent = ClaudeCodeCLIAgent([sys.executable, str(FIXTURE)])
    metadata = policy()
    metadata["claudeCode"]["options"].update(maxTurns=12, research={}, researchPrTools=pr_tools)
    with pytest.raises(ValueError, match="broker allowlist"):
        await agent.new_session(str(tmp_path), servers(), **metadata)
    assert not list(tmp_path.glob(".caipe-cli-*"))


@pytest.mark.parametrize("task, report_number", [("research example", 1), ("research-repair", 2)])
async def test_cancellation_during_report_usage_withholds_final_and_delegation_metadata(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, task: str, report_number: int) -> None:
    agent, client, session = await research_configured(tmp_path, monkeypatch)
    original = client.session_update
    reports = 0

    async def cancel_on_usage(session_id: str, update: Any) -> None:
        nonlocal reports
        await original(session_id, update)
        if getattr(update, "session_update", None) == "agent_thought_chunk" and '"phase": "Report"' in update.content.text:
            reports += 1
            if reports == report_number:
                assert agent.process is not None and agent.process.returncode == 0
                await agent.cancel(session_id)

    monkeypatch.setattr(client, "session_update", cancel_on_usage)
    result = await agent.prompt(session, [TextContentBlock(type="text", text=task)])
    assert reports == report_number
    assert result.stop_reason == "cancelled" and result.field_meta is None
    assert not any(event.session_update == "agent_message_chunk" for event in client.events)
    assert agent.research is None and agent.process is None


async def test_deadline_drains_the_cli_and_releases_no_unverified_report(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    agent, client, session = await research_configured(tmp_path, monkeypatch)
    # Compress the production policy's validated deadline for this drain test.
    monkeypatch.setattr(agent.research_policy, "max_seconds", 0.1)
    await agent.prompt(session, [TextContentBlock(type="text", text="research-wait")])
    assert agent.process is None
    messages = [event.content.text for event in client.events if event.session_update == "agent_message_chunk"]
    assert len(messages) == 1 and "deadline" in messages[0]


async def test_research_rejects_too_small_turn_budget_during_configuration(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    with pytest.raises(ValueError, match="at least six turns"):
        await research_configured(tmp_path, monkeypatch, max_turns=4)
    assert not (tmp_path / "research-calls.jsonl").exists()


async def test_cancellation_stops_later_passes_and_drains_native_process(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    agent, client, session = await research_configured(tmp_path, monkeypatch)
    task = asyncio.create_task(agent.prompt(session, [TextContentBlock(type="text", text="research-wait")]))
    for _ in range(200):
        if (tmp_path / "cli-started").exists():
            break
        await asyncio.sleep(0.01)
    assert (tmp_path / "cli-started").exists()
    await agent.cancel(session)
    assert (await asyncio.wait_for(task, 3)).stop_reason == "cancelled"
    assert agent.process is None and agent.research is None
    assert not any(event.session_update == "agent_message_chunk" for event in client.events)


async def test_research_requires_os_isolation_before_starting_a_process(settings: Settings) -> None:
    profiles = json.loads(settings.claude_sdk_profiles_json)
    profiles["safe"]["research"] = {}
    adapter = ClaudeACPAdapter(settings.model_copy(update={"claude_sdk_profiles_json": json.dumps(profiles),
                                                          "claude_acp_runtime": "claude_code_cli_acp",
                                                          "claude_cli_isolation": "disabled"}))
    with pytest.raises(ValueError, match="isolated"):
        async for _ in adapter._stream(context(), [], {}):
            pytest.fail("A research process was started without isolation")


@pytest.mark.parametrize("research, tools", [(True, ["Read"]), (False, [])])
async def test_artifact_only_worker_requires_research_without_native_tools(settings: Settings, research: bool, tools: list[str]) -> None:
    profiles = json.loads(settings.claude_sdk_profiles_json)
    if research:
        profiles["safe"]["research"] = {}
    adapter = ClaudeACPAdapter(settings.model_copy(update={"claude_sdk_profiles_json": json.dumps(profiles),
                                                          "claude_acp_runtime": "claude_code_cli_acp",
                                                          "claude_cli_isolation": "artifacts",
                                                          "claude_acp_tools": tools}))
    with pytest.raises(ValueError, match="no native tools"):
        async for _ in adapter._stream(context(), [], {}):
            pytest.fail("Artifact-only mode allowed a native filesystem tool")
