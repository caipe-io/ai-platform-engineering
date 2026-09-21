"""Webhook delivery dedup via the ``trigger_instances`` MongoDB collection.

Why
---
Most webhook senders deliver at least once. GitHub retries on a 10s timeout,
PagerDuty retries on any non-2xx, and operators occasionally replay payloads
manually for debugging. Without a server-side dedup table the autonomous
task runs once per *delivery* rather than once per *event*, which causes:

* duplicate side-effects (a Jira ticket created twice, two PR comments,
  two pages on-call),
* duplicate cost against the supervisor / dynamic-agents service,
* misleading run history that mixes "the agent ran twice" with "the
  sender retried twice".

This module turns the autonomous-agents service into "exactly-once" w.r.t.
sender retries by recording every accepted delivery in a Mongo collection
keyed on a unique dedup key. A second delivery whose dedup key collides
with an existing row is rejected at the front of the webhook handler and
the *original* run id is returned to the sender.

Dedup key precedence (see :func:`derive_dedup_key`):

1. ``WebhookTrigger.dedup_header`` is configured AND the request carries
   it -> ``f"{task_id}:hdr:{header_value}"``. Most senders give us a
   stable per-delivery id (``X-GitHub-Delivery``, ``X-PagerDuty-Webhook-Id``,
   ``X-Stripe-Signature`` t-component, etc.); using it directly is the
   most reliable strategy.
2. The webhook is signed AND we just verified the HMAC ->
   ``f"{task_id}:sig:{signature_hex}"``. The signature is a
   sha256(secret, timestamp + body) and is *already* computed for auth,
   so we get dedup for free with zero new hashing logic.
3. Neither -> no dedup is possible. The route logs a warning and runs
   the task without recording a row. Operators who want dedup must
   either configure ``dedup_header`` or enable HMAC signing.

The collection has a TTL index on ``received_at`` so abandoned dedup
records age out (default 7 days, configurable).
"""

from __future__ import annotations

import hashlib
import logging
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import TYPE_CHECKING, Any, Literal, Mapping

from autonomous_agents.models import TaskDefinition, WebhookTrigger

if TYPE_CHECKING:  # pragma: no cover - import-cycle break
    from autonomous_agents.services.mongo import MongoService

logger = logging.getLogger("autonomous_agents")

DedupStrategy = Literal["header", "signature", "none"]


@dataclass(frozen=True)
class DedupKey:
    """Outcome of :func:`derive_dedup_key`.

    ``key`` is ``None`` when neither strategy applies (no dedup header
    configured/present AND request was not signed). Callers MUST treat
    that as "skip the claim and run the task without dedup".
    """

    key: str | None
    strategy: DedupStrategy
    header_name: str | None = None
    header_value: str | None = None


@dataclass(frozen=True)
class TriggerClaim:
    """Outcome of :func:`claim_trigger_instance`.

    * ``claimed=True`` -- this is the first time we've seen this delivery;
      caller should pre-allocate a ``run_id`` and fire the task.
    * ``claimed=False`` -- a row with this ``dedup_key`` already exists;
      caller should NOT fire the task and should return the
      ``existing_run_id`` (may be ``None`` if the original claim crashed
      before attaching a run id).
    """

    dedup_key: str
    strategy: DedupStrategy
    claimed: bool
    existing_run_id: str | None
    header_name: str | None = None
    header_value: str | None = None


def _strip_signature_prefix(signature: str) -> str:
    """Drop the ``sha256=`` prefix from an HMAC signature header value.

    Keeps the dedup key compact and avoids leaking the literal
    ``X-Hub-Signature-256`` wire format into the persistence layer.
    Returns ``signature`` unchanged when no recognised prefix is present
    so future signature schemes (``sha512=``, etc.) still produce a
    usable key.
    """
    for prefix in ("sha256=", "sha512=", "sha1="):
        if signature.startswith(prefix):
            return signature[len(prefix) :]
    return signature


def _lookup_header(headers: Mapping[str, str] | Any, name: str) -> tuple[str | None, str | None]:
    """Case-insensitive header lookup that returns ``(canonical_name, value)``.

    FastAPI's ``request.headers`` is already case-insensitive, but unit
    tests sometimes pass a plain ``dict`` and we want the helper to be
    robust either way. The returned ``canonical_name`` preserves the
    case the sender used so the audit row reflects the wire reality.
    """
    if headers is None:
        return None, None
    # Try the fast path first -- Starlette / httpx Headers objects
    # implement case-insensitive ``__getitem__`` and ``get``.
    try:
        value = headers.get(name)  # type: ignore[union-attr]
    except AttributeError:
        value = None
    if value is not None:
        return name, value
    # Fallback: linear scan with case-folded compare for plain dicts.
    target = name.casefold()
    for raw_key, raw_value in (
        headers.items() if hasattr(headers, "items") else []
    ):
        if str(raw_key).casefold() == target:
            return str(raw_key), str(raw_value)
    return None, None


def derive_dedup_key(
    *,
    task: TaskDefinition,
    headers: Mapping[str, str] | Any,
    verified_signature: str | None,
    default_dedup_header: str | None = None,
) -> DedupKey:
    """Choose the most reliable dedup key for an incoming webhook.

    Parameters
    ----------
    task:
        The webhook task that owns this endpoint. We read
        ``trigger.dedup_header`` to know which header (if any) the
        operator configured as the per-delivery id.
    headers:
        The request headers. Case-insensitive lookup is applied.
    verified_signature:
        The HMAC signature value the route just confirmed matches the
        body. Pass ``None`` when no secret is configured (signature
        strategy is unavailable). The ``sha256=`` prefix is stripped
        before incorporation into the key.
    default_dedup_header:
        Adapter-declared per-delivery header (e.g. ``X-GitHub-Delivery``
        for the github adapter). Used only when the task has no
        ``dedup_header`` of its own; the per-task value always wins so
        operators can override the adapter's default for an unusual
        upstream variant.

    Returns
    -------
    DedupKey
        ``key`` is ``None`` when neither strategy applies. Always returns
        a populated ``strategy`` so callers can audit/log even when
        dedup is impossible.
    """
    trigger = task.trigger if isinstance(task.trigger, WebhookTrigger) else None
    dedup_header = (trigger.dedup_header if trigger is not None else None) or default_dedup_header

    if dedup_header:
        canonical, value = _lookup_header(headers, dedup_header)
        if value:
            return DedupKey(
                key=f"{task.id}:hdr:{value}",
                strategy="header",
                header_name=canonical,
                header_value=value,
            )
        # Header configured but absent on this request: fall through to
        # the signature path so well-signed deliveries still dedup.
        logger.warning(
            "[%s] dedup_header=%r configured but missing from request; "
            "falling back to signature-based dedup",
            task.id,
            dedup_header,
        )

    if verified_signature:
        signature_token = _strip_signature_prefix(verified_signature)
        return DedupKey(
            key=f"{task.id}:sig:{signature_token}",
            strategy="signature",
        )

    # Neither strategy works -- caller will skip the claim and run the
    # task without dedup protection. We log loudly so operators can
    # spot misconfigured tasks in production.
    logger.warning(
        "[%s] no dedup possible (no dedup_header configured/present and "
        "no HMAC signature verified); duplicate deliveries from the "
        "sender will fire the task more than once",
        task.id,
    )
    return DedupKey(key=None, strategy="none")


def _body_sha256(body: bytes) -> str:
    """Hex sha256 of the raw request body for audit purposes only.

    Stored on the row but not used for dedup -- it lets forensics
    answer "did the same body arrive under two different signatures?"
    without having to retain bodies themselves.
    """
    return hashlib.sha256(body).hexdigest()


async def claim_trigger_instance(
    mongo: "MongoService",
    *,
    task_id: str,
    dedup_key: DedupKey,
    body: bytes,
) -> TriggerClaim:
    """Insert a row in ``trigger_instances`` or report a duplicate.

    Pre-condition: ``dedup_key.key is not None``. Callers that hit a
    ``DedupKey`` with no key MUST skip this helper entirely.

    Returns
    -------
    TriggerClaim
        ``claimed=True`` when the insert succeeded (this is a new
        delivery). ``claimed=False`` when the ``_id`` collided with an
        existing row -- the caller should look at
        ``existing_run_id`` to tell the sender which run their original
        delivery produced.
    """
    if dedup_key.key is None:
        # Belt-and-braces: a misuse here would corrupt the collection.
        raise ValueError(
            "claim_trigger_instance called with no dedup key -- "
            "callers must short-circuit when derive_dedup_key returns "
            "strategy='none'"
        )

    doc: dict[str, Any] = {
        "_id": dedup_key.key,
        "task_id": task_id,
        "received_at": datetime.now(timezone.utc),
        "body_sha256": _body_sha256(body),
        "body_size_bytes": len(body),
        "dedup_strategy": dedup_key.strategy,
        "delivery_header_name": dedup_key.header_name,
        "delivery_header_value": dedup_key.header_value,
        "run_id": None,
    }

    created, existing = await mongo.record_trigger_instance(doc)
    if created:
        return TriggerClaim(
            dedup_key=dedup_key.key,
            strategy=dedup_key.strategy,
            claimed=True,
            existing_run_id=None,
            header_name=dedup_key.header_name,
            header_value=dedup_key.header_value,
        )

    existing_run_id = (existing or {}).get("run_id") if existing else None
    return TriggerClaim(
        dedup_key=dedup_key.key,
        strategy=dedup_key.strategy,
        claimed=False,
        existing_run_id=existing_run_id,
        header_name=dedup_key.header_name,
        header_value=dedup_key.header_value,
    )
