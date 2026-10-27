"""Sign the verified Webex event context for native app dispatch through the BFF."""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import time
from typing import Any
from urllib.parse import urlsplit


def native_assistant_headers(
    *, url: str, payload: dict[str, Any], body: bytes, bearer_token: str,
) -> dict[str, str]:
    """Bind the bot's room assertion to the exact OBO token and outgoing request.

    Call only with context from the authenticated Webex event handler after its
    room/identity gates. An absent key leaves existing Dynamic Agents calls
    unchanged; native app dispatch rejects unsigned requests.
    """
    secret = os.environ.get("WEBEX_LINK_HMAC_SECRET", "").strip()
    if len(secret.encode()) < 32:
        return {}
    context = payload.get("client_context")
    if not isinstance(context, dict):
        return {}
    room, space, thread = (context.get(key) for key in ("webex_room_id", "webex_space_id", "webex_thread_parent_id"))
    direct = context.get("webex_is_direct")
    if not all(isinstance(value, str) and value for value in (room, space, thread)) or not isinstance(direct, bool):
        return {}
    proof = {
        "version": 1, "client": "webex", "kind": "direct" if direct else "group",
        "roomId": room, "spaceId": space, "threadId": thread,
        "conversationId": payload.get("conversation_id"), "agentId": payload.get("agent_id"),
        "method": "POST", "path": urlsplit(url).path, "iat": int(time.time()),
        "bodyHash": hashlib.sha256(body).hexdigest(),
        "tokenHash": hashlib.sha256(bearer_token.encode()).hexdigest(),
    }
    encoded = base64.urlsafe_b64encode(json.dumps(proof, separators=(",", ":"), ensure_ascii=False).encode()).rstrip(b"=").decode()
    return {"x-caipe-webex-context": encoded,
            "x-caipe-webex-signature": hmac.new(secret.encode(), ("caipe.webex.assistant.v1\n" + encoded).encode(), hashlib.sha256).hexdigest()}
