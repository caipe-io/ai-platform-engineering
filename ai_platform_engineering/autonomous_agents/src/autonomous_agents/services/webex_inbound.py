"""Webex inbound dispatcher + lightweight Webex API client.

The dispatcher is the only piece of business logic; HTTP routing,
signature checks, and Mongo lookups live in other modules.

The :class:`WebexClient` is a deliberately minimal HTTP shim:
``get_me`` + ``get_message`` for the inbound route, plus
``list_webhooks`` / ``create_webhook`` / ``delete_webhook`` for
startup-time registration in :func:`ensure_webhook_registered`.
"""

from __future__ import annotations

import enum
import logging
from dataclasses import dataclass
from typing import Any, Awaitable, Callable, Mapping

import httpx

from autonomous_agents.services.webex_threads import WebexThreadEntry

logger = logging.getLogger("autonomous_agents")


# ---------------------------------------------------------------------------
# Dispatcher domain
# ---------------------------------------------------------------------------


class Verdict(str, enum.Enum):
    DROP_LOOPGUARD = "drop_loopguard"
    DROP_NOT_THREAD_REPLY = "drop_not_thread_reply"
    DROP_NO_MAPPING = "drop_no_mapping"
    FORWARD = "forward"


@dataclass(frozen=True, slots=True)
class FollowUpPayload:
    """Resolved follow-up coordinates the route hands to ``fire_webhook_task``.

    Pre-consolidation this was serialized to a JSON envelope and POSTed
    to ``/api/v1/hooks/{task_id}/follow-up``. In-process we just build a
    :class:`models.FollowUpContext` from the same fields.
    """

    task_id: str
    parent_run_id: str
    user_text: str
    user_ref: str | None
    transport: str = "webex"


@dataclass(frozen=True, slots=True)
class DispatchResult:
    verdict: Verdict
    payload: FollowUpPayload | None = None
    reason: str | None = None  # human-readable detail for logs / responses


# ``ThreadLookup`` returns the dataclass directly so the dispatcher can
# use attribute access (``mapping.task_id``) instead of dict ``.get``.
# Tests pass an in-memory implementation that constructs
# ``WebexThreadEntry`` values.
ThreadLookup = Callable[[str], Awaitable[WebexThreadEntry | None]]
FetchMessage = Callable[[str], Awaitable[Mapping[str, Any]]]


async def dispatch_message_event(
    event: Mapping[str, Any],
    *,
    bot_person_id: str,
    fetch_message: FetchMessage,
    lookup_thread: ThreadLookup,
) -> DispatchResult:
    """Decide what to do with a Webex ``messages.created`` event.

    Args:
        event: the raw JSON Webex POSTs to ``/api/v1/hooks/webex/events``.
            Must include ``data.id`` (the new message id) and ideally
            ``data.personId`` (so we can short-circuit the bot's own
            posts without fetching the message body -- saves a Webex
            API round-trip on the common case).
        bot_person_id: the bot's own ``personId`` -- compared against
            the event's authoring person to short-circuit feedback
            loops.
        fetch_message: ``async (message_id) -> dict`` -- typically
            :meth:`WebexClient.get_message`. Injected so tests don't
            need to fake an httpx transport.
        lookup_thread: ``async (parent_message_id) -> WebexThreadEntry | None``
            -- queries the Mongo ``webex_thread_map`` collection.
            Returns ``None`` when no autonomous task posted that parent.

    Returns:
        A :class:`DispatchResult` whose ``verdict`` is one of:

        * DROP_LOOPGUARD -- bot's own post. Common: a task just
          posted via ``post_message`` and Webex echoed it back.
        * DROP_NOT_THREAD_REPLY -- top-level message in a room the
          bot is in. We don't route those.
        * DROP_NO_MAPPING -- real reply, but to a message no
          autonomous task posted.
        * FORWARD -- legitimate operator follow-up; ``payload`` is
          set and ready to fire.
    """
    data = event.get("data") or {}
    message_id = data.get("id")
    if not message_id:
        # Webex never sends this in practice; defensive log + drop.
        # Also covers Webex's webhook-creation test pings which arrive
        # with no ``data`` body -- the route returns 200 ignored.
        return DispatchResult(
            verdict=Verdict.DROP_NOT_THREAD_REPLY,
            reason="event has no data.id",
        )

    # Cheap pre-check: if the event already tells us the author is the
    # bot, drop without paying for the fetch_message round-trip.
    event_person_id = data.get("personId")
    if event_person_id and event_person_id == bot_person_id:
        return DispatchResult(
            verdict=Verdict.DROP_LOOPGUARD,
            reason="event personId matches bot",
        )

    message = await fetch_message(message_id)

    # Authoritative loop guard: even if the event lacked personId, the
    # fetched message always has it.
    if message.get("personId") == bot_person_id:
        return DispatchResult(
            verdict=Verdict.DROP_LOOPGUARD,
            reason="message personId matches bot",
        )

    parent_id = message.get("parentId")
    if not parent_id:
        return DispatchResult(
            verdict=Verdict.DROP_NOT_THREAD_REPLY,
            reason="message has no parentId",
        )

    mapping = await lookup_thread(parent_id)
    if mapping is None:
        return DispatchResult(
            verdict=Verdict.DROP_NO_MAPPING,
            reason=f"parentId {parent_id} not in thread map",
        )

    # The thread map row is canonical. WebexThreadEntry is constructed
    # with non-optional ``task_id`` / ``run_id`` so this branch is
    # belt-and-suspenders against a future adapter that decides to
    # build entries from a partial Mongo row.
    task_id = mapping.task_id
    parent_run_id = mapping.run_id
    if not task_id or not parent_run_id:
        logger.warning(
            "Thread map entry for parentId=%s is missing task_id/run_id; "
            "treating as no mapping",
            parent_id,
        )
        return DispatchResult(
            verdict=Verdict.DROP_NO_MAPPING,
            reason=f"thread map entry for {parent_id} is malformed",
        )

    user_text = (message.get("text") or message.get("markdown") or "").strip()
    if not user_text:
        # Webex strips leading @mentions from ``text`` for you, so an
        # empty body usually means the user sent only a card or a file
        # with no caption. Nothing useful to forward.
        return DispatchResult(
            verdict=Verdict.DROP_NOT_THREAD_REPLY,
            reason="message has no text body",
        )

    return DispatchResult(
        verdict=Verdict.FORWARD,
        payload=FollowUpPayload(
            task_id=task_id,
            parent_run_id=parent_run_id,
            user_text=user_text,
            user_ref=message.get("personEmail"),
        ),
    )


# ---------------------------------------------------------------------------
# Webex REST client -- minimal surface
# ---------------------------------------------------------------------------


class WebexClient:
    """Bot-token-authenticated client for the Webex REST API.

    Holds a long-lived :class:`httpx.AsyncClient` so the inbound route's
    per-event ``get_message`` doesn't pay TCP/TLS setup. Registration
    chores at startup borrow the same client.

    Closed by :class:`autonomous_agents.main` on lifespan exit.
    """

    def __init__(
        self,
        token: str,
        *,
        base_url: str,
        timeout: float = 15.0,
    ) -> None:
        # Authorization: Bearer <bot-token> on every call.
        self._client = httpx.AsyncClient(
            base_url=base_url.rstrip("/"),
            headers={"Authorization": f"Bearer {token}"},
            timeout=timeout,
        )

    async def aclose(self) -> None:
        await self._client.aclose()

    async def get_me(self) -> dict[str, Any]:
        """Return the authenticated bot's own ``person`` record.

        Used by the dispatcher to identify and drop events whose
        ``personId`` matches the bot itself, without which every
        ``post_message`` from a task would re-trigger the bridge in an
        infinite loop.
        """
        resp = await self._client.get("/people/me")
        resp.raise_for_status()
        return resp.json()

    async def get_message(self, message_id: str) -> dict[str, Any]:
        """Return the full Webex message record for ``message_id``.

        Webex webhook events only deliver the message id (intentionally:
        the webhook payload is sent over a customer-controlled URL and
        Webex doesn't want to leak conversation contents to a
        misconfigured endpoint). The route fetches the body server-side
        over an authenticated channel.
        """
        resp = await self._client.get(f"/messages/{message_id}")
        resp.raise_for_status()
        return resp.json()

    async def list_webhooks(self) -> list[dict[str, Any]]:
        resp = await self._client.get("/webhooks")
        resp.raise_for_status()
        return resp.json().get("items", []) or []

    async def create_webhook(
        self,
        *,
        name: str,
        target_url: str,
        resource: str = "messages",
        event: str = "created",
        secret: str | None = None,
        filter_expression: str | None = None,
    ) -> dict[str, Any]:
        """Register a Webex webhook for ``resource``/``event`` on ``target_url``.

        ``secret`` enables Webex's HMAC-SHA1 signing of every delivery
        (header ``X-Spark-Signature``). Strongly recommended -- without
        it any client that knows the public URL can forge events.
        """
        body: dict[str, Any] = {
            "name": name,
            "targetUrl": target_url,
            "resource": resource,
            "event": event,
        }
        if secret is not None:
            body["secret"] = secret
        if filter_expression is not None:
            body["filter"] = filter_expression
        resp = await self._client.post("/webhooks", json=body)
        resp.raise_for_status()
        return resp.json()

    async def delete_webhook(self, webhook_id: str) -> None:
        resp = await self._client.delete(f"/webhooks/{webhook_id}")
        resp.raise_for_status()


# ---------------------------------------------------------------------------
# Idempotent Webex webhook registration (startup-time)
# ---------------------------------------------------------------------------


# Distinct from the legacy bot's ``"caipe-autonomous-followups"`` name
# so the two registrations can coexist on a Webex tenant during the
# cutover without thrashing each other on restart.
WEBHOOK_REGISTRATION_NAME = "caipe-autonomous-inbound"


async def ensure_webhook_registered(
    webex: WebexClient,
    *,
    target_url: str,
    name: str = WEBHOOK_REGISTRATION_NAME,
    secret: str | None = None,
) -> dict[str, Any]:
    """Make sure exactly one ``messages.created`` webhook points at us.

    Idempotent strategy:

    * If a webhook with our ``name`` exists pointing at the same
      ``target_url`` AND its signed/unsigned state matches our current
      ``secret`` argument -- leave it.
    * Otherwise (stale URL OR signed/unsigned mismatch) -- delete it
      and recreate. Keeps the dev-loop on ngrok painless AND prevents
      the silent-rejection trap where a secret was added to ``.env``
      on a second restart but the Webex side still has the unsigned
      webhook registered.
    * If none exist -- create a fresh one.

    Deliberately does NOT scan for "any webhook pointing at this
    target_url" -- operators may manage several caipe instances
    against one Webex bot; only webhooks matching ``name`` are ours.
    """
    existing = await webex.list_webhooks()
    ours = [w for w in existing if w.get("name") == name]

    desired_signed = bool(secret)

    for wh in ours:
        existing_signed = bool(wh.get("secret"))
        if (
            wh.get("targetUrl") == target_url
            and existing_signed == desired_signed
        ):
            logger.info(
                "Webex webhook %s already points at %s (signed=%s) -- reusing",
                wh.get("id"),
                target_url,
                desired_signed,
            )
            return wh

        reason_bits: list[str] = []
        if wh.get("targetUrl") != target_url:
            reason_bits.append(f"url {wh.get('targetUrl')!r} -> {target_url!r}")
        if existing_signed != desired_signed:
            reason_bits.append(f"signed {existing_signed} -> {desired_signed}")
        try:
            await webex.delete_webhook(wh["id"])
            logger.info(
                "Deleted stale Webex webhook %s (%s)",
                wh["id"],
                "; ".join(reason_bits) or "no reason captured",
            )
        except httpx.HTTPError as exc:
            logger.warning(
                "Failed to delete stale Webex webhook %s: %s", wh["id"], exc
            )

    created = await webex.create_webhook(
        name=name,
        target_url=target_url,
        resource="messages",
        event="created",
        secret=secret,
    )
    logger.info(
        "Registered Webex webhook %s -> %s (signed=%s)",
        created.get("id"),
        target_url,
        secret is not None,
    )
    return created
