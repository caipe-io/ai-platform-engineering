"""Keep failed ontology generations from replacing the current version."""

import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest

from agent_ontology import agent as agent_module
from agent_ontology.agent import OntologyAgent
from common import constants


@pytest.fixture
def agent(monkeypatch: pytest.MonkeyPatch) -> OntologyAgent:
  monkeypatch.setenv("LLM_PROVIDER", "openai")
  monkeypatch.setenv("DEBUG_AGENT", "false")
  monkeypatch.setattr(agent_module.utils, "get_logger", Mock(return_value=Mock()))
  monkeypatch.setattr(agent_module.utils, "get_uuid", Mock(return_value="new-version"))
  monkeypatch.setattr(agent_module, "build_chat_model", Mock())
  monkeypatch.setattr(agent_module, "CallbackHandler", Mock())
  redis = AsyncMock()
  redis.get.return_value = "current-version"
  instance = OntologyAgent(AsyncMock(), AsyncMock(), redis, 3, 0.1, 2, 100)
  instance.data_graph_db.get_all_entity_types.return_value = ["primary", "secondary"]
  instance.process_all = AsyncMock()
  instance.sync_all_relations = AsyncMock()
  instance._group_and_filter_candidates = AsyncMock(return_value={("primary", "secondary"): ([], [], "changed")})
  instance.prepare_candidate_group_data = AsyncMock(return_value=SimpleNamespace(heuristic_change_reason=""))
  return instance


@pytest.fixture
def new_manager(monkeypatch: pytest.MonkeyPatch) -> Mock:
  manager = Mock(ontology_version_id="new-version", cleanup=AsyncMock())
  current_manager = Mock(ontology_version_id="current-version")
  monkeypatch.setattr(agent_module, "RelationCandidateManager", Mock(side_effect=[manager, current_manager]))
  return manager


@pytest.fixture
def worker(monkeypatch: pytest.MonkeyPatch) -> Mock:
  instance = Mock(total_evaluation_count=1)
  instance.create_agent = AsyncMock(return_value=Mock(ainvoke=AsyncMock()))
  monkeypatch.setattr(agent_module, "AgentWorker", Mock(return_value=instance))
  return instance


@pytest.mark.asyncio
@pytest.mark.parametrize("failure", ["missing-provider", "model-construction", "worker-construction", "worker-retries"])
async def test_failed_evaluation_preserves_current_version(agent: OntologyAgent, new_manager: Mock, worker: Mock, monkeypatch: pytest.MonkeyPatch, failure: str) -> None:
  if failure == "missing-provider":
    monkeypatch.delenv("LLM_PROVIDER")
    expected_error = ValueError
    message = "LLM_PROVIDER"
  else:
    expected_error = RuntimeError
    message = "evaluation failed"
    error = RuntimeError(message)
    if failure == "model-construction":
      monkeypatch.setattr(agent_module, "build_chat_model", Mock(side_effect=error))
    elif failure == "worker-construction":
      worker.create_agent.side_effect = error
    else:
      worker.create_agent.return_value.ainvoke.side_effect = error
      monkeypatch.setattr(agent_module.asyncio, "sleep", AsyncMock())

  with pytest.raises(expected_error, match=message):
    await agent.process_and_evaluate_all()

  agent.redis.set.assert_not_awaited()
  agent.sync_all_relations.assert_not_awaited()
  new_manager.cleanup.assert_not_awaited()
  assert agent.is_evaluating is False
  if failure == "worker-retries":
    assert worker.create_agent.return_value.ainvoke.await_count == 5


@pytest.mark.asyncio
async def test_failed_heuristics_preserves_current_version(agent: OntologyAgent, new_manager: Mock) -> None:
  # Exercise the real processing method so a swallowed graph error cannot
  # pass this test through a mocked phase boundary.
  agent.process_all = OntologyAgent.process_all.__get__(agent)
  agent.data_graph_db.get_entity_count.side_effect = RuntimeError("graph unavailable")

  with pytest.raises(RuntimeError, match="graph unavailable"):
    await agent.process_and_evaluate_all()

  agent.redis.set.assert_not_awaited()
  agent.sync_all_relations.assert_not_awaited()
  new_manager.cleanup.assert_not_awaited()
  assert agent.is_processing is False


@pytest.mark.asyncio
@pytest.mark.parametrize("phase", ["processing", "evaluating"])
async def test_busy_phase_does_not_publish_an_unevaluated_version(agent: OntologyAgent, new_manager: Mock, phase: str) -> None:
  if phase == "processing":
    agent.process_all = OntologyAgent.process_all.__get__(agent)
  setattr(agent, f"is_{phase}", True)

  with pytest.raises(RuntimeError, match="already in progress"):
    await agent.process_and_evaluate_all()

  agent.redis.set.assert_not_awaited()
  new_manager.cleanup.assert_not_awaited()
  assert getattr(agent, f"is_{phase}") is True


@pytest.mark.asyncio
async def test_worker_failure_waits_for_other_workers_before_releasing_guard(agent: OntologyAgent, new_manager: Mock, monkeypatch: pytest.MonkeyPatch) -> None:
  agent._group_and_filter_candidates.return_value[("primary", "tertiary")] = ([], [], "changed")
  started = asyncio.Event()
  release = asyncio.Event()
  failed_worker = Mock(create_agent=AsyncMock(side_effect=RuntimeError("worker failed")))
  other_worker = Mock(total_evaluation_count=1)

  async def create_agent(*args: object) -> Mock:
    started.set()
    await release.wait()
    return Mock(ainvoke=AsyncMock())

  other_worker.create_agent = AsyncMock(side_effect=create_agent)
  monkeypatch.setattr(agent_module, "AgentWorker", Mock(side_effect=[failed_worker, other_worker]))
  task = asyncio.create_task(agent.process_and_evaluate_all())
  try:
    await asyncio.wait_for(started.wait(), timeout=5)
    assert agent.is_evaluating is True
    agent.redis.set.assert_not_awaited()
  finally:
    release.set()
    with pytest.raises(RuntimeError, match="worker failed"):
      await asyncio.wait_for(task, timeout=5)

  assert agent.is_evaluating is False
  agent.redis.set.assert_not_awaited()
  new_manager.cleanup.assert_not_awaited()


@pytest.mark.asyncio
@pytest.mark.parametrize("has_candidates", [True, False])
async def test_successful_evaluation_publishes_before_cleanup(agent: OntologyAgent, new_manager: Mock, worker: Mock, monkeypatch: pytest.MonkeyPatch, has_candidates: bool) -> None:
  if not has_candidates:
    agent._group_and_filter_candidates.return_value = {}
    monkeypatch.delenv("LLM_PROVIDER")

  async def publish(key: str, value: str) -> None:
    assert agent.is_evaluating is False
    assert key == constants.KV_ONTOLOGY_VERSION_ID_KEY
    assert value == "new-version"
    if has_candidates:
      worker.create_agent.return_value.ainvoke.assert_awaited_once()
    new_manager.cleanup.assert_not_awaited()

  agent.redis.set.side_effect = publish
  await agent.process_and_evaluate_all()

  agent.redis.set.assert_awaited_once_with(constants.KV_ONTOLOGY_VERSION_ID_KEY, "new-version")
  agent.sync_all_relations.assert_awaited_once_with(new_manager)
  new_manager.cleanup.assert_awaited_once()
  assert agent.is_processing is False
  assert agent.is_evaluating is False


@pytest.mark.asyncio
@pytest.mark.parametrize("failing_step", ["sync", "cleanup"])
async def test_failed_post_publish_step_releases_processing_guard(agent: OntologyAgent, new_manager: Mock, worker: Mock, failing_step: str) -> None:
  error = RuntimeError(f"{failing_step} failed")
  if failing_step == "sync":
    agent.sync_all_relations.side_effect = error
  else:
    new_manager.cleanup.side_effect = error

  with pytest.raises(RuntimeError, match=f"{failing_step} failed"):
    await agent.process_and_evaluate_all()

  assert agent.is_processing is False
  assert agent.agent_status_msg == "Idle"


@pytest.mark.asyncio
@pytest.mark.parametrize(("value", "expected"), [("0.7  # creative", 0.7), ("invalid", 0.0), ("3", 2.0)])
async def test_provider_temperature_setting(agent: OntologyAgent, new_manager: Mock, worker: Mock, monkeypatch: pytest.MonkeyPatch, value: str, expected: float) -> None:
  monkeypatch.setenv("OPENAI_TEMPERATURE", value)

  await agent.process_and_evaluate_all()

  agent_module.build_chat_model.assert_called_once_with("openai", temperature=expected)


@pytest.mark.asyncio
async def test_second_generation_is_rejected_between_phases(agent: OntologyAgent, new_manager: Mock, worker: Mock) -> None:
  # Pause the first run while it publishes, when neither phase flag is set.
  publishing = asyncio.Event()
  release = asyncio.Event()

  async def publish(*args: object) -> None:
    publishing.set()
    await release.wait()

  agent.redis.set.side_effect = publish
  first_run = asyncio.create_task(agent.process_and_evaluate_all())
  try:
    await asyncio.wait_for(publishing.wait(), timeout=5)
    assert agent.is_processing is False
    assert agent.is_evaluating is False
    assert agent.is_busy is True

    with pytest.raises(RuntimeError, match="generation is already in progress"):
      await agent.process_and_evaluate_all()
  finally:
    release.set()
    await asyncio.wait_for(first_run, timeout=5)

  agent.process_all.assert_awaited_once()
  new_manager.cleanup.assert_awaited_once()
  assert agent.is_generating is False
  assert agent.is_busy is False
