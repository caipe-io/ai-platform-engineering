"""Sign trusted Webex interaction metadata for BFF authorization gates."""

from __future__ import annotations

import hashlib
import hmac
import os
import time
from typing import Literal

InteractionKind = Literal["direct", "group"]


def signed_interaction_headers(
    *, method: str, path: str, kind: InteractionKind
) -> dict[str, str]:
    secret = (
        os.environ.get("WEBEX_LINK_HMAC_SECRET", "").strip()
        or os.environ.get("WEBEX_SIGNING_SECRET", "").strip()
    )
    if not secret:
        return {}
    timestamp = str(int(time.time()))
    payload = "\n".join(("webex", kind, timestamp, method.upper(), path))
    signature = hmac.new(
        secret.encode("utf-8"), payload.encode("utf-8"), hashlib.sha256
    ).hexdigest()
    return {
        "X-CAIPE-Interaction-Source": "webex",
        "X-CAIPE-Interaction-Kind": kind,
        "X-CAIPE-Interaction-Timestamp": timestamp,
        "X-CAIPE-Interaction-Signature": signature,
    }
