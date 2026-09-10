"""Webhook trigger endpoints — external systems POST here to fire tasks.

Receipt and execution are deliberately decoupled: the route claims a
``trigger_instances`` row, pre-allocates a ``run_id``, and returns
``202 Accepted`` immediately. The actual task run happens in a tracked
background coroutine. This keeps the response well under GitHub's
~10s webhook timeout (otherwise the sender retries and we end up with
duplicate runs) and prevents a slow supervisor call from tying up the
ASGI worker pool.

Dedup is enforced by the unique ``_id`` on ``trigger_instances``: a
duplicate delivery (same dedup header value, or same HMAC signature)
returns ``200 OK`` with the *original* run id rather than re-firing
the task. See :mod:`autonomous_agents.services.trigger_instances` for
the dedup-key precedence.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import logging
import math
import time
from typing import Any

from fastapi import APIRouter, BackgroundTasks, HTTPException, Request, Response

from autonomous_agents.config import get_settings
from autonomous_agents.models import (
    FollowUpContext,
    TaskDefinition,
    WebhookPayload,
    WebhookTrigger,
)
from autonomous_agents.services.task_runner import get_run_store
from autonomous_agents.services.trigger_instances import (
    DedupKey,
    derive_dedup_key,
)
from autonomous_agents.services.webhook_adapters import (
    VerificationResult,
    WebhookAdapter,
    get_adapter,
)
from autonomous_agents.services.webhook_limits import read_limited_webhook_body
from autonomous_agents.services.webhook_runtime import (
    dispatch_webhook_run,
    get_webhook_task,
)

logger = logging.getLogger("autonomous_agents")
router = APIRouter(tags=["webhooks"])


def _resolve_secret(task: TaskDefinition) -> tuple[str | None, str]:
    """Return ``(secret, source)`` for HMAC validation.

    Per-task ``trigger.secret`` wins; if absent we fall back to the
    service-wide ``WEBHOOK_SECRET`` env var. The ``source`` string is
    intended only for log/audit context — never log the secret itself.
    """
    if isinstance(task.trigger, WebhookTrigger) and task.trigger.secret:
        return task.trigger.secret, "task"

    fallback = get_settings().webhook_secret
    if fallback:
        return fallback, "global"

    return None, "none"


def _validate_timestamp(raw: str | None, window: int) -> float:
    """Parse + range-check the ``X-Webhook-Timestamp`` header.

    Retained as a public shim for callers / tests that pre-date the
    YAML adapter layer; the github adapter delegates to
    :func:`services.webhook_adapters._validate_timestamp_window` for the
    same behaviour.
    """
    if not raw:
        raise HTTPException(
            status_code=401,
            detail="Missing X-Webhook-Timestamp header (replay protection enabled)",
        )

    try:
        ts = float(raw)
    except (TypeError, ValueError) as exc:
        raise HTTPException(
            status_code=400, detail="X-Webhook-Timestamp must be a numeric epoch"
        ) from exc

    if not math.isfinite(ts):
        raise HTTPException(
            status_code=400, detail="X-Webhook-Timestamp must be a finite number"
        )

    now = time.time()
    if abs(now - ts) > window:
        raise HTTPException(
            status_code=401,
            detail=f"Webhook timestamp outside ±{window}s replay window",
        )

    return ts


def _expected_signature(secret: str, body: bytes, timestamp_header: str | None) -> str:
    """Compute the legacy GitHub-shaped ``sha256=...`` signature.

    Public shim retained for tests and library callers that signed
    payloads against the original hard-coded contract. The github
    adapter computes the same value internally; new code should call
    the adapter rather than this helper.
    """
    signed = (
        timestamp_header.encode("utf-8") + b"." + body
        if timestamp_header is not None
        else body
    )
    digest = hmac.new(secret.encode("utf-8"), signed, hashlib.sha256).hexdigest()
    return f"sha256={digest}"


def _resolve_adapter(task: TaskDefinition) -> WebhookAdapter:
    """Look up the adapter for ``task``'s webhook provider.

    Centralised so the route, the follow-up route, and any future
    helpers all hit the same registry. Raises :class:`HTTPException`
    (status 500) when the operator references an unknown provider id —
    that's a configuration mistake, not a sender error.
    """
    if not isinstance(task.trigger, WebhookTrigger):
        raise HTTPException(
            status_code=500,
            detail=f"Task '{task.id}' is not a webhook task",
        )
    return get_adapter(task.trigger.provider)


def _parse_context(body: bytes) -> dict[str, Any]:
    """Best-effort parse request body into a dict context."""
    if not body:
        return {}

    try:
        data = json.loads(body)
    except (json.JSONDecodeError, TypeError, ValueError):
        return {}

    return data if isinstance(data, dict) else {}


async def _verify_followup_signature(
    task: TaskDefinition,
    body: bytes,
    headers: Any,
) -> tuple[str | None, str | None]:
    """Shared HMAC + replay-window check for follow-up requests.

    Inbound-bridge contract:

    * The bridge always signs with the **global** ``WEBHOOK_SECRET``
      (not the per-task ``trigger.secret``). A bridge isn't part of the
      task-creation flow and so cannot know each task's secret.
    * The bridge always uses ``X-Hub-Signature-256: sha256=<hex>`` as
      the signature header and HMAC-SHA256 over the body (or
      ``f"{ts}.{body}"`` when ``X-Webhook-Timestamp`` is present),
      regardless of what provider scheme the *original* webhook
      delivery used. Provider variation (slack / pagerduty / jira /
      etc.) only applies to inbound third-party webhooks; bridges
      are first-party and pick a single fixed scheme.

    The github adapter's signing contract matches what bridges produce
    (``X-Hub-Signature-256`` prefixed_hex + optional ``X-Webhook-
    Timestamp``), so we always use the global secret + github adapter
    here regardless of the task's ``trigger.provider``.

    Returns ``(verified_signature, default_dedup_header)`` so the
    caller can feed both into :func:`derive_dedup_key` without
    re-deriving them. Raises :class:`HTTPException` on verification
    failure.
    """
    settings = get_settings()
    # Bridge always signs with the global secret; per-task
    # ``trigger.secret`` is irrelevant on this path.
    secret = settings.webhook_secret
    # Bridge always uses the github wire shape regardless of what
    # the original webhook sender was (slack / pagerduty / jira /
    # generic_hmac, etc.). Bridges are first-party and pick one
    # signing scheme.
    adapter = get_adapter("github")
    result = adapter.verify(
        secret=secret,
        body=body,
        headers=headers,
        replay_window_seconds=settings.webhook_replay_window_seconds,
    )
    return result.canonical_signature, result.default_dedup_header


@router.post("/hooks/{task_id}")
async def receive_webhook(
    task_id: str,
    request: Request,
    response: Response,
    background_tasks: BackgroundTasks,
) -> dict:
    """Accept an incoming webhook and dispatch the matching task asynchronously.

    Flow:

    1. Look up the webhook task; 404 on unknown ids.
    2. Resolve the provider adapter (github / slack / pagerduty /
       generic_hmac / operator-supplied) and verify HMAC + replay-window
       per that adapter's contract when a secret is configured.
    3. Short-circuit provider-recognised ping deliveries with HTTP 200
       (no run, no row) — e.g. GitHub's ``X-GitHub-Event: ping``.
    4. Derive a dedup key (per-task header > adapter default header >
       verified signature > none) and hand off to
       :func:`dispatch_webhook_run`, which owns the shared
       claim / spawn / envelope tail.
    """
    task = get_webhook_task(task_id)
    if not task:
        raise HTTPException(status_code=404, detail=f"No webhook task found for id '{task_id}'")
    adapter = _resolve_adapter(task)

    settings = get_settings()
    body = await read_limited_webhook_body(
        request, max_bytes=settings.webhook_max_payload_bytes
    )

    # Track the *verified* signature so the dedup helper can use it as
    # a dedup key when no per-task header is configured. We only set
    # this AFTER the adapter's compare_digest confirms the sender's
    # value matches; using an unverified signature would let an attacker
    # poison the dedup table.
    secret, _source = _resolve_secret(task)
    result: VerificationResult = adapter.verify(
        secret=secret,
        body=body,
        headers=request.headers,
        replay_window_seconds=settings.webhook_replay_window_seconds,
    )
    verified_signature = result.canonical_signature

    if result.is_ping:
        # Provider-recognised ping (e.g. GitHub's X-GitHub-Event: ping):
        # never produce a run AND never create a dedup row -- it's a
        # one-off configuration check, not a real event.
        logger.info(
            "Ignoring %s ping delivery for webhook task '%s'",
            adapter.provider_id,
            task_id,
        )
        return {
            "status": "ignored",
            "reason": f"{adapter.provider_id}_ping",
            "task_id": task_id,
        }

    dedup_key = derive_dedup_key(
        task=task,
        headers=request.headers,
        verified_signature=verified_signature,
        default_dedup_header=result.default_dedup_header,
    )

    context = _parse_context(body)
    payload_dict = WebhookPayload(data=context).model_dump()

    outcome = await dispatch_webhook_run(
        task=task,
        dedup_key=dedup_key,
        body=body,
        context=payload_dict,
        follow_up=None,
        background_tasks=background_tasks,
        max_pending_per_task=settings.webhook_max_pending_per_task,
        max_pending_per_owner=settings.webhook_max_pending_per_owner,
        max_pending_global=settings.webhook_max_pending_global,
        max_pending_payload_bytes_global=(
            settings.webhook_max_pending_payload_bytes_global
        ),
        max_concurrent_per_owner=settings.webhook_max_concurrent_per_owner,
        max_concurrent_global=settings.webhook_max_concurrent_global,
    )

    response.status_code = outcome.status_code

    if not outcome.claimed:
        # Duplicate delivery -- sender retried. Return the original
        # run id so the sender (or anyone watching their logs) can
        # correlate.
        logger.info(
            "[%s] Duplicate webhook delivery deduped (key=%s strategy=%s "
            "existing_run_id=%s)",
            task_id,
            dedup_key.key,
            dedup_key.strategy,
            outcome.run_id,
        )
        return {
            "status": "deduped",
            "run_id": outcome.run_id,
            "task_id": task_id,
            "trigger_instance_id": outcome.trigger_instance_id,
            "dedup_strategy": outcome.dedup_strategy,
        }

    # Fresh fire (claim path or no-dedup path). The ``trigger_instance_id``
    # is only included when a claim row actually exists; the no-dedup
    # branch deliberately omits it from the response envelope (matching
    # the legacy shape).
    envelope: dict[str, Any] = {
        "status": "accepted",
        "run_id": outcome.run_id,
        "task_id": task_id,
        "dedup_strategy": outcome.dedup_strategy,
    }
    if outcome.trigger_instance_id is not None:
        envelope["trigger_instance_id"] = outcome.trigger_instance_id
    return envelope


@router.post("/hooks/{task_id}/follow-up")
async def receive_followup(
    task_id: str,
    request: Request,
    response: Response,
    background_tasks: BackgroundTasks,
) -> dict:
    """Re-fire an existing webhook task with operator follow-up text.

    Used by inbound bridges to forward an in-thread reply back to the
    task that started the thread. The body is a JSON
    :class:`FollowUpContext`; HMAC validation reuses the task's webhook
    secret so the bridge can sign with the same key it uses for the
    initial fire path.

    The resulting :class:`TaskRun` is linked to its parent via
    ``parent_run_id`` so the chat-thread synthesiser can render a
    single threaded timeline. The route returns ``202`` immediately
    after kicking off the background task, rather than streaming the
    new run's events -- the bridge polls ``/tasks/{task_id}/runs`` (or
    the chat publisher) for the terminal state.

    Dedup is applied here too: the dedup key incorporates the
    follow-up's ``parent_run_id`` so distinct replies to the same
    parent don't collide, but a retry of the same reply (same body,
    same signature) is rejected as a duplicate.
    """
    task = get_webhook_task(task_id)
    if not task:
        raise HTTPException(
            status_code=404,
            detail=f"No webhook task found for id '{task_id}'",
        )
    _resolve_adapter(task)  # 500 early on misconfigured provider id

    settings = get_settings()
    body = await read_limited_webhook_body(
        request, max_bytes=settings.webhook_max_payload_bytes
    )
    verified_signature, default_dedup_header = await _verify_followup_signature(
        task, body, request.headers
    )

    try:
        parsed = json.loads(body) if body else {}
    except (json.JSONDecodeError, TypeError, ValueError) as exc:
        raise HTTPException(
            status_code=400, detail="Follow-up body must be valid JSON"
        ) from exc
    if not isinstance(parsed, dict):
        raise HTTPException(
            status_code=400, detail="Follow-up body must be a JSON object"
        )

    try:
        follow_up = FollowUpContext.model_validate(parsed)
    except ValueError as exc:
        # Pydantic raises ValidationError (a ValueError subclass) for
        # missing / mistyped fields. Surface the message verbatim so the
        # bridge author can see exactly which field is wrong.
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    # Defensive: confirm the parent run actually belongs to this task
    # so a misrouted follow-up cannot graft itself onto a foreign
    # task's chat thread. We list the task's recent runs (capped at
    # the same value as the /tasks/{id}/runs endpoint) and verify
    # the parent id is in that set; an unknown id 404s, a known id
    # owned by a different task is impossible by construction since
    # we only scan this task's runs. Using list_by_task instead of a
    # bespoke get(run_id) keeps the RunStore protocol unchanged.
    recent = await get_run_store().list_by_task(task_id, limit=500)
    if not any(r.run_id == follow_up.parent_run_id for r in recent):
        raise HTTPException(
            status_code=404,
            detail=(
                f"Parent run '{follow_up.parent_run_id}' not found for "
                f"task '{task_id}'"
            ),
        )

    # Dedup for follow-ups: derive a key that scopes to the
    # ``parent_run_id`` so distinct in-thread replies don't collide on
    # the same parent. Header strategy still wins when configured;
    # signature strategy mixes in the parent id since multiple replies
    # to the same parent are signed with the same secret but distinct
    # bodies (and therefore distinct signatures), making this mostly
    # redundant -- but the explicit prefix keeps the dedup namespace
    # disjoint from initial-fire deliveries on the same task.
    base_dedup = derive_dedup_key(
        task=task,
        headers=request.headers,
        verified_signature=verified_signature,
        default_dedup_header=default_dedup_header,
    )
    dedup_key = (
        DedupKey(
            key=f"{base_dedup.key}:followup:{follow_up.parent_run_id}",
            strategy=base_dedup.strategy,
            header_name=base_dedup.header_name,
            header_value=base_dedup.header_value,
        )
        if base_dedup.key is not None
        else base_dedup
    )

    outcome = await dispatch_webhook_run(
        task=task,
        dedup_key=dedup_key,
        body=body,
        context={},
        follow_up=follow_up,
        background_tasks=background_tasks,
        max_pending_per_task=settings.webhook_max_pending_per_task,
        max_pending_per_owner=settings.webhook_max_pending_per_owner,
        max_pending_global=settings.webhook_max_pending_global,
        max_pending_payload_bytes_global=(
            settings.webhook_max_pending_payload_bytes_global
        ),
        max_concurrent_per_owner=settings.webhook_max_concurrent_per_owner,
        max_concurrent_global=settings.webhook_max_concurrent_global,
    )

    response.status_code = outcome.status_code

    if not outcome.claimed:
        logger.info(
            "[%s] Duplicate follow-up deduped (key=%s strategy=%s "
            "existing_run_id=%s)",
            task_id,
            dedup_key.key,
            dedup_key.strategy,
            outcome.run_id,
        )
        return {
            "status": "deduped",
            "run_id": outcome.run_id,
            "task_id": task_id,
            "parent_run_id": follow_up.parent_run_id,
            "trigger_instance_id": outcome.trigger_instance_id,
            "dedup_strategy": outcome.dedup_strategy,
        }

    # Fresh follow-up fire.
    if outcome.trigger_instance_id is None:
        logger.info(
            "[%s] Follow-up run %s queued (parent=%s, transport=%s, no dedup)",
            task_id,
            outcome.run_id,
            follow_up.parent_run_id,
            follow_up.transport or "unknown",
        )
    else:
        logger.info(
            "[%s] Follow-up run %s queued (parent=%s, transport=%s, dedup=%s)",
            task_id,
            outcome.run_id,
            follow_up.parent_run_id,
            follow_up.transport or "unknown",
            outcome.dedup_strategy,
        )
    envelope: dict[str, Any] = {
        "status": "accepted",
        "run_id": outcome.run_id,
        "task_id": task_id,
        "parent_run_id": follow_up.parent_run_id,
        "dedup_strategy": outcome.dedup_strategy,
    }
    if outcome.trigger_instance_id is not None:
        envelope["trigger_instance_id"] = outcome.trigger_instance_id
    return envelope
