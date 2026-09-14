"""Webex inbound webhook route.

Fan-in endpoint at ``POST /api/v1/hooks/webex/events`` that receives
Webex ``messages.created`` deliveries, resolves the parent message to
an autonomous task via the ``webex_thread_map`` collection, and re-fires
that task with the operator's reply as :class:`FollowUpContext`.

Failure-mode contract
---------------------

* **Feature not configured** (``WEBEX_BOT_TOKEN`` unset): returns
  ``503 Service Unavailable`` with ``Retry-After: 30`` and a clear
  ``detail``. The route exists statically -- 503 honestly signals
  "endpoint present, feature off" rather than 404 (which lies about
  existence). Webex retries on 503 so a brief deploy gap doesn't drop
  events.
* **Bad/missing HMAC** when secret configured: ``401`` from the
  ``webex`` adapter in :mod:`services.webhook_adapters`. Generic message
  -- no forgery oracle.
* **Webex API error fetching message body**: ``502`` so Webex retries.
* **Mongo dedup store unreachable**: ``503`` so Webex retries.
* **Drops** (loopguard / not-a-reply / no mapping): ``200`` with
  ``{"status": "ignored", "verdict": "..."}``. Webex sees success and
  does not retry.
* **Duplicate delivery** (same ``X-Spark-Signature``): ``200`` with the
  original ``run_id``.
* **Forward**: ``202`` after the background task is scheduled.
"""

from __future__ import annotations

import json
import logging
from typing import Any

import httpx
from fastapi import APIRouter, BackgroundTasks, HTTPException, Request, Response

from autonomous_agents.config import get_settings
from autonomous_agents.models import FollowUpContext
from autonomous_agents.services.task_runner import (
    get_run_store,
    get_webex_thread_map,
)
from autonomous_agents.services.trigger_instances import (
    DedupKey,
    _strip_signature_prefix,
)
from autonomous_agents.services.webex_inbound import (
    Verdict,
    WebexClient,
    dispatch_message_event,
)
from autonomous_agents.services.webhook_adapters import get_adapter
from autonomous_agents.services.webhook_limits import read_limited_webhook_body
from autonomous_agents.services.webhook_runtime import (
    dispatch_webhook_run,
    get_webhook_task,
)

logger = logging.getLogger("autonomous_agents")
router = APIRouter(tags=["webex"])


# ---------------------------------------------------------------------------
# Module-level state, injected by the FastAPI lifespan in ``main.py``.
# Matches the existing pattern used by :mod:`services.task_runner`
# (``set_run_store``, ``set_webex_thread_map``, etc.) so unit tests can
# swap in fakes without spinning up the whole lifespan.
# ---------------------------------------------------------------------------


_webex_client: WebexClient | None = None
_bot_person_id: str | None = None


def set_webex_client(client: WebexClient | None) -> None:
    """Inject the long-lived :class:`WebexClient`.

    ``None`` means Webex is disabled at startup (no token configured);
    the route then returns 503 on every request via its
    ``webex_enabled`` short-circuit.
    """
    global _webex_client
    _webex_client = client


def set_bot_person_id(person_id: str | None) -> None:
    """Inject the bot's own ``personId`` for the dispatcher's loopguard."""
    global _bot_person_id
    _bot_person_id = person_id


def get_webex_client() -> WebexClient | None:
    return _webex_client


def get_bot_person_id() -> str | None:
    return _bot_person_id


# ---------------------------------------------------------------------------
# Route
# ---------------------------------------------------------------------------


@router.post("/hooks/webex/events")
async def receive_webex_event(
    request: Request,
    response: Response,
    background_tasks: BackgroundTasks,
) -> dict[str, Any]:
    """Receive a Webex webhook delivery and route it back as a follow-up.

    Decision flow:

    1. **Feature gate.** If ``settings.webex_enabled`` is False (no
       ``WEBEX_BOT_TOKEN``), return 503. The route is statically
       mounted and exists; 503 + ``Retry-After`` is the honest answer
       and is what Webex's retry logic understands.
    2. **Signature verification** via the ``webex`` adapter from the
       YAML registry. HMAC-SHA1 over the raw body, no timestamp, no
       ``sha1=`` prefix.
    3. **Body parse.** Webex test deliveries arrive with no ``data``
       field; treat as a no-op 200.
    4. **Dispatcher.** Fetches the message body via the Webex API and
       returns ``DROP_*`` or ``FORWARD``.
    5. **Forward path:** derive the Webex-specific dedup key
       (signature suffixed with ``:followup:{parent_run_id}``), check
       the parent run actually belongs to the resolved task, and hand
       off to :func:`dispatch_webhook_run` for the shared claim /
       spawn / envelope tail.
    """
    settings = get_settings()
    if not settings.webex_enabled:
        # Statically-mounted path exists; the feature is just unconfigured.
        # 503 + Retry-After is what Webex's retry logic acts on cleanly.
        response.headers["Retry-After"] = "30"
        response.status_code = 503
        return {"detail": "webex inbound not configured"}

    webex = get_webex_client()
    bot_person_id = get_bot_person_id()
    if webex is None or bot_person_id is None:
        # Token was set but lifespan failed to initialise the client.
        # Treat the same as "not configured" from Webex's perspective so
        # they retry; the operator sees the failure in startup logs.
        logger.warning(
            "Webex inbound enabled but client/person_id not initialised; "
            "returning 503 so Webex retries"
        )
        response.headers["Retry-After"] = "30"
        response.status_code = 503
        return {"detail": "webex inbound not initialised"}

    body = await read_limited_webhook_body(
        request, max_bytes=settings.webhook_max_payload_bytes
    )

    # ---- HMAC verify -------------------------------------------------
    adapter = get_adapter("webex")
    result = adapter.verify(
        secret=settings.webex_webhook_secret,
        body=body,
        headers=request.headers,
        replay_window_seconds=settings.webhook_replay_window_seconds,
    )
    verified_signature = result.canonical_signature

    # ---- Parse + dispatch -------------------------------------------
    try:
        event = json.loads(body) if body else {}
    except Exception:
        raise HTTPException(status_code=400, detail="invalid JSON body")

    if not isinstance(event, dict) or "data" not in event:
        # Webex's webhook-creation test ping has no ``data`` body; surface
        # as a clean 200 ignored so operators see green during setup.
        return {"status": "ignored", "reason": "no event data"}

    thread_map = get_webex_thread_map()
    if thread_map is None:
        # Lifespan didn't wire a thread map -- shouldn't happen in prod
        # but is the cleanest failure mode for a misconfigured test env.
        logger.error("Webex thread map not configured; cannot dispatch")
        raise HTTPException(
            status_code=503, detail="webex thread map not configured"
        )

    try:
        dispatch = await dispatch_message_event(
            event,
            bot_person_id=bot_person_id,
            fetch_message=webex.get_message,
            lookup_thread=thread_map.lookup,
        )
    except httpx.HTTPError as exc:
        # Webex API blip fetching the message body; let Webex retry.
        logger.warning("Webex API error fetching message: %s", exc)
        raise HTTPException(status_code=502, detail="webex api error")

    if dispatch.verdict is not Verdict.FORWARD:
        logger.info(
            "Dropping Webex event: verdict=%s reason=%s",
            dispatch.verdict.value,
            dispatch.reason,
        )
        return {"status": "ignored", "verdict": dispatch.verdict.value}

    assert dispatch.payload is not None  # type narrow
    payload = dispatch.payload

    # ---- Resolve the task --------------------------------------------
    # ``register_webhook_task`` registers tasks in the in-memory
    # ``services.webhook_runtime`` keyed by id. This fan-in route
    # resolves the task at request time via the thread map. We pull the
    # TaskDefinition from the same registry so a disabled task doesn't
    # fire (the registry is the source of truth for "is this task
    # active?"). The previous version reached into
    # ``routes/webhooks._webhook_tasks`` directly via a deferred import;
    # the registry split lets both routes consume it as peers.
    task = get_webhook_task(payload.task_id)
    if task is None:
        # Thread map pointed at a task that's been deleted/disabled
        # since it originally posted. 404 lets Webex stop retrying.
        logger.warning(
            "Webex follow-up resolved to unknown/disabled task '%s' "
            "(parent_run=%s); thread-map row should be cleaned up",
            payload.task_id,
            payload.parent_run_id,
        )
        raise HTTPException(
            status_code=404,
            detail=f"No webhook task found for id '{payload.task_id}'",
        )

    # Belt-and-suspenders: confirm the parent run actually belongs to
    # this task. The thread map is the authoritative source -- a
    # mismatch here would indicate schema drift or a hand-edited row.
    # Future readers should NOT over-engineer this check; it exists
    # purely to fail loud instead of misrouting follow-ups across tasks
    # if the map is somehow corrupt.
    recent = await get_run_store().list_by_task(payload.task_id, limit=500)
    if not any(r.run_id == payload.parent_run_id for r in recent):
        raise HTTPException(
            status_code=404,
            detail=(
                f"Parent run '{payload.parent_run_id}' not found for "
                f"task '{payload.task_id}'"
            ),
        )

    # ---- Dedup -------------------------------------------------------
    # Webex retries deliver the same body and therefore the same
    # signature, which makes signature-based dedup meaningful even
    # without an X-GitHub-Delivery-style header. Scope the key to the
    # parent_run_id so two distinct replies to the same parent (signed
    # with the same secret but distinct bodies -> distinct signatures)
    # remain disjoint deliveries.
    #
    # NOTE: dedup-key derivation lives here rather than in
    # ``dispatch_webhook_run`` because each call site has its own
    # rules; the shared helper consumes a pre-built key.
    if verified_signature is None:
        # Unsigned mode (dev). No dedup possible.
        dedup_key = DedupKey(key=None, strategy="none")
    else:
        # ``derive_dedup_key`` shape: "{task_id}:sig:{hex}". We then
        # suffix ":followup:{parent_run_id}" so this follow-up shares a
        # disjoint namespace with original-fire deliveries and other
        # replies to different parents.
        sig_token = _strip_signature_prefix(verified_signature)
        dedup_key = DedupKey(
            key=(
                f"{payload.task_id}:sig:{sig_token}"
                f":followup:{payload.parent_run_id}"
            ),
            strategy="signature",
        )

    follow_up = FollowUpContext(
        parent_run_id=payload.parent_run_id,
        user_text=payload.user_text,
        user_ref=payload.user_ref,
        transport=payload.transport,
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
            "[%s] Duplicate Webex follow-up deduped (key=%s "
            "existing_run_id=%s)",
            payload.task_id,
            dedup_key.key,
            outcome.run_id,
        )
        return {
            "status": "deduped",
            "run_id": outcome.run_id,
            "task_id": payload.task_id,
            "parent_run_id": payload.parent_run_id,
            "trigger_instance_id": outcome.trigger_instance_id,
            "dedup_strategy": outcome.dedup_strategy,
        }

    if outcome.trigger_instance_id is None:
        logger.info(
            "[%s] Webex follow-up run %s queued (parent=%s, no dedup)",
            payload.task_id,
            outcome.run_id,
            payload.parent_run_id,
        )
    else:
        logger.info(
            "[%s] Webex follow-up run %s queued (parent=%s, dedup=%s)",
            payload.task_id,
            outcome.run_id,
            payload.parent_run_id,
            outcome.dedup_strategy,
        )
    envelope: dict[str, Any] = {
        "status": "accepted",
        "run_id": outcome.run_id,
        "task_id": payload.task_id,
        "parent_run_id": payload.parent_run_id,
        "dedup_strategy": outcome.dedup_strategy,
    }
    if outcome.trigger_instance_id is not None:
        envelope["trigger_instance_id"] = outcome.trigger_instance_id
    return envelope
