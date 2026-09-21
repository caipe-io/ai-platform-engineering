"""Webhook provider adapters — pluggable HMAC verification per upstream.

Each upstream that posts to ``/api/v1/hooks/{task_id}`` ships its own
signing contract. GitHub puts a ``sha256=<hex>`` value in
``X-Hub-Signature-256`` over the raw body. Slack puts a ``v0=<hex>`` in
``X-Slack-Signature`` over ``v0:<ts>:<body>`` and *requires* a timestamp
header. PagerDuty puts ``v1=<hex>,v1=<hex>`` (comma-separated, multiple
entries during secret rotation) in ``X-PagerDuty-Signature``.

Hard-coding any one of these into the route — as the original
implementation did for GitHub — meant adding a new upstream forced a
fork of the routing code. This module replaces that with a YAML-driven
registry: a :class:`WebhookAdapter` per provider id, each with the
header name, scheme, hashing algorithm, payload template, and optional
ping / replay-window / dedup hints declared up-front.

Verification is the only behaviour that changes per provider; the
trigger_instances dedup helper, run pre-allocation, BackgroundTasks
plumbing, and Mongo back-link in :mod:`routes.webhooks` are all
adapter-agnostic and stay untouched.

Public surface
--------------

* :class:`WebhookAdapter` — one per provider id; immutable, threadsafe.
* :class:`VerificationResult` — outcome the route consumes: did the
  signature check pass, what canonical signature should we feed to
  ``derive_dedup_key``, was this delivery a ping, and did the adapter
  configure a default ``dedup_header``.
* :func:`load_adapters` — read a YAML file, parse, return an
  ``{provider_id: WebhookAdapter}`` mapping. Called once at lifespan
  start.
* :func:`get_adapter` / :func:`set_adapters` — process-global
  registry the route looks up against.

The bundled defaults live in ``autonomous_agents/webhook_providers.yaml``;
operators can override via the ``WEBHOOK_PROVIDERS_FILE`` env var.
"""

from __future__ import annotations

import hashlib
import hmac
import logging
import math
import time
from base64 import b64decode, b64encode
from dataclasses import dataclass, field
from importlib import resources
from pathlib import Path
from typing import Any, Mapping

import yaml
from fastapi import HTTPException

logger = logging.getLogger("autonomous_agents")


# =============================================================================
# Result types
# =============================================================================


@dataclass(frozen=True)
class VerificationResult:
    """Outcome of :meth:`WebhookAdapter.verify`.

    * ``ok`` — verification succeeded (or no secret was configured, in
      which case it is trivially ``True`` and ``canonical_signature`` is
      ``None``).
    * ``canonical_signature`` — server-computed signature value the
      route should hand to :func:`services.trigger_instances.derive_dedup_key`.
      Always in ``"<algo>=<hex>"`` form for hex schemes (e.g. ``sha256=abcd...``)
      and the bare base64 string for ``raw_base64`` schemes, so the dedup
      strategy stays uniform regardless of provider.
    * ``is_ping`` — adapter recognised this delivery as a configuration
      ping (e.g. GitHub's ``X-GitHub-Event: ping``). The route short-circuits
      these BEFORE creating any trigger_instances row.
    * ``default_dedup_header`` — adapter-declared per-delivery header
      (e.g. ``X-GitHub-Delivery``). Only used when the task has no
      ``dedup_header`` of its own; the per-task value still wins.
    """

    ok: bool
    canonical_signature: str | None
    is_ping: bool
    default_dedup_header: str | None


# =============================================================================
# Adapter dataclasses
# =============================================================================


@dataclass(frozen=True)
class _SignatureSpec:
    header: str
    scheme: str  # "prefixed_hex" | "kv_csv" | "raw_base64"
    algorithm: str  # "sha256" | "sha1" | "sha512"
    encoding: str  # "hex" | "base64"
    prefix: str | None = None
    signature_keys: tuple[str, ...] = field(default_factory=tuple)
    timestamp_key: str | None = None


@dataclass(frozen=True)
class _TimestampSpec:
    header: str | None
    fmt: str  # "unix_seconds"
    bind_into_payload: bool
    required: bool
    tolerance_seconds: int | None
    from_signature_header: bool


@dataclass(frozen=True)
class _PingSpec:
    header: str
    value: str


@dataclass(frozen=True)
class WebhookAdapter:
    """Immutable per-provider verification policy."""

    provider_id: str
    signature: _SignatureSpec
    timestamp: _TimestampSpec | None
    payload_template: str
    timestamped_payload_template: str | None
    ping: _PingSpec | None
    default_dedup_header: str | None

    # ------------------------------------------------------------------
    # Public API used by routes.webhooks
    # ------------------------------------------------------------------

    def is_ping_delivery(self, headers: Mapping[str, str] | Any) -> bool:
        """Return True iff this looks like an upstream config-test ping."""
        if not self.ping:
            return False
        actual = _header_get(headers, self.ping.header)
        return (actual or "").strip().lower() == self.ping.value.strip().lower()

    def verify(
        self,
        *,
        secret: str | None,
        body: bytes,
        headers: Mapping[str, str] | Any,
        replay_window_seconds: int,
    ) -> VerificationResult:
        """Verify ``body`` against ``secret`` per this adapter's contract.

        ``replay_window_seconds`` is the operator's global window from
        ``Settings.webhook_replay_window_seconds``. Provider-specific
        ``timestamp.tolerance_seconds`` (e.g. Slack's mandatory 300s)
        is honoured when set; otherwise the global value applies. A
        per-provider ``timestamp.required: true`` always forces timestamp
        validation regardless of the global window.

        Raises :class:`HTTPException` (status 400/401) on verification
        failure; never returns ``ok=False`` (the route uses status codes
        to differentiate auth failures from successful no-op cases).
        """
        is_ping = self.is_ping_delivery(headers)

        if not secret:
            # Nothing to verify against — trivially OK. Still surface the
            # ping flag so the route can short-circuit unsigned pings too.
            return VerificationResult(
                ok=True,
                canonical_signature=None,
                is_ping=is_ping,
                default_dedup_header=self.default_dedup_header,
            )

        # ---- Timestamp handling ----------------------------------------
        # The window we actually enforce is the provider's mandated value
        # (when it sets one) OR the operator's global value, whichever
        # is non-zero. ``required=True`` forces enforcement regardless.
        ts_value: str | None = None
        ts_for_payload: str | None = None
        effective_window = self._effective_window(replay_window_seconds)
        timestamp_active = effective_window > 0 and self.timestamp is not None
        timestamp_required = (
            self.timestamp is not None and self.timestamp.required
        ) or timestamp_active

        if self.timestamp is not None and timestamp_required:
            ts_value = self._extract_timestamp(headers)
            if ts_value is None and self.timestamp.required:
                raise HTTPException(
                    status_code=401,
                    detail=(
                        f"Missing {self.timestamp.header} header "
                        "(replay protection enabled)"
                    ),
                )
            if ts_value is None and timestamp_active:
                # github-style: window > 0 means the operator turned
                # replay-protection on; the timestamp header is therefore
                # mandatory even if the provider doesn't list it as
                # ``required: true`` in the YAML.
                raise HTTPException(
                    status_code=401,
                    detail=(
                        f"Missing {self.timestamp.header or 'X-Webhook-Timestamp'} "
                        "header (replay protection enabled)"
                    ),
                )
            if ts_value is not None and effective_window > 0:
                _validate_timestamp_window(
                    ts_value,
                    effective_window,
                    header_name=self.timestamp.header
                    or "X-Webhook-Timestamp",
                )

            # Decide whether the timestamp gets baked into the signed
            # payload. ``bind_into_payload`` (github-style) only binds
            # when window > 0; providers like Slack always bind via
            # their ``payload_template``.
            if ts_value is not None and (
                self.timestamp.bind_into_payload or self.timestamp.required
            ):
                ts_for_payload = ts_value

        # ---- Build signed payload --------------------------------------
        signed_payload = self._build_payload(body, ts_for_payload)

        # ---- Extract candidate signatures from header -------------------
        header_value = _header_get(headers, self.signature.header)
        if not header_value:
            raise HTTPException(
                status_code=401,
                detail=f"Missing {self.signature.header} header",
            )

        candidates = self._extract_signature_candidates(header_value)
        if not candidates:
            raise HTTPException(
                status_code=401,
                detail=f"Missing {self.signature.header} header",
            )

        # ---- Compute expected and compare ------------------------------
        expected = self._compute_signature(secret, signed_payload)

        for candidate in candidates:
            if hmac.compare_digest(expected, candidate):
                # Canonical form: locked to the server-computed value so
                # the dedup namespace doesn't shift on header capitalisation
                # or sender-side prefix variants.
                canonical = self._canonical_signature(expected)
                return VerificationResult(
                    ok=True,
                    canonical_signature=canonical,
                    is_ping=is_ping,
                    default_dedup_header=self.default_dedup_header,
                )

        # No candidate matched. Generic message — don't echo the expected
        # value (forgery oracle).
        logger.warning(
            "Webhook signature mismatch (provider=%s)", self.provider_id
        )
        raise HTTPException(status_code=401, detail="Invalid webhook signature")

    # ------------------------------------------------------------------
    # Internals
    # ------------------------------------------------------------------

    def _effective_window(self, global_window: int) -> int:
        if self.timestamp is None:
            return 0
        if self.timestamp.tolerance_seconds is not None:
            # Provider-mandated tolerance (e.g. Slack 300s). When
            # operators want to *tighten* further, they can lower the
            # provider value in the YAML; we don't intersect with the
            # global setting here because the global is intended for
            # GH-style providers that have no native tolerance.
            return self.timestamp.tolerance_seconds
        return max(0, global_window)

    def _extract_timestamp(
        self, headers: Mapping[str, str] | Any
    ) -> str | None:
        if self.timestamp is None:
            return None
        if self.timestamp.from_signature_header:
            # Stripe-style: timestamp lives inside the signature header
            # itself (e.g. "t=12345,v1=abcd"). The kv_csv branch
            # populates ``signature.timestamp_key``; we re-parse here.
            header_value = _header_get(headers, self.signature.header)
            if not header_value:
                return None
            kv = _parse_kv_csv(header_value)
            return kv.get(self.signature.timestamp_key or "t", [None])[0]
        if self.timestamp.header:
            return _header_get(headers, self.timestamp.header)
        return None

    def _build_payload(self, body: bytes, ts: str | None) -> bytes:
        """Render ``payload_template`` (or ``timestamped_payload_template``).

        Templates use ``{body}`` and ``{timestamp}`` placeholders. We
        intentionally do **not** use ``str.format`` on the body — bytes
        in Python 3 don't support format-spec, and decoding to text would
        break non-UTF-8 webhook payloads. Instead we splice byte-by-byte.
        """
        if ts is not None and self.timestamped_payload_template is not None:
            template = self.timestamped_payload_template
        elif ts is not None and "{timestamp}" in self.payload_template:
            template = self.payload_template
        else:
            template = self.payload_template

        # Fast path: pure body.
        if template == "{body}":
            return body

        # Split on {body}; encode the surrounding text segments and
        # interpolate {timestamp} per segment. This keeps body bytes
        # untouched.
        if "{body}" not in template:
            raise ValueError(
                f"payload_template for provider {self.provider_id!r} "
                "must contain {body}"
            )
        before, after = template.split("{body}", 1)
        ts_str = ts or ""
        before = before.replace("{timestamp}", ts_str)
        after = after.replace("{timestamp}", ts_str)
        return before.encode("utf-8") + body + after.encode("utf-8")

    def _extract_signature_candidates(self, header_value: str) -> list[str]:
        """Return list of canonicalised hex/base64 signature values.

        For ``prefixed_hex``: strips the prefix and lower-cases the hex.
        For ``kv_csv``: returns every value whose key matches one of
        ``signature_keys`` (PagerDuty-style multi-signature rotation).
        For ``raw_base64``: returns the trimmed value verbatim.
        """
        scheme = self.signature.scheme
        value = header_value.strip()

        if scheme == "prefixed_hex":
            if self.signature.prefix and value.lower().startswith(
                self.signature.prefix.lower()
            ):
                value = value[len(self.signature.prefix) :]
            # Empty after prefix strip means the sender sent only the
            # prefix; treat as missing.
            if not value:
                return []
            return [self._canonical_signature_hex(value)]

        if scheme == "kv_csv":
            kv = _parse_kv_csv(value)
            keys = self.signature.signature_keys or ("v1",)
            out: list[str] = []
            for key in keys:
                for v in kv.get(key, []):
                    if v:
                        out.append(self._canonical_signature_hex(v))
            return out

        if scheme == "raw_base64":
            # Normalise via decode/re-encode so case-insensitive padding
            # variants compare equal.
            try:
                raw = b64decode(value, validate=True)
            except (ValueError, TypeError):
                return []
            return [b64encode(raw).decode("ascii")]

        raise ValueError(
            f"Unknown signature scheme {scheme!r} for provider {self.provider_id!r}"
        )

    def _compute_signature(self, secret: str, signed_payload: bytes) -> str:
        digestmod = _hash_for(self.signature.algorithm)
        mac = hmac.new(secret.encode("utf-8"), signed_payload, digestmod)
        if self.signature.encoding == "base64":
            return b64encode(mac.digest()).decode("ascii")
        return mac.hexdigest()

    def _canonical_signature_hex(self, hex_value: str) -> str:
        return hex_value.strip().lower()

    def _canonical_signature(self, expected: str) -> str:
        """Public-shape signature suitable for trigger_instances dedup."""
        if self.signature.encoding == "base64":
            return expected
        return f"{self.signature.algorithm}={expected}"


# =============================================================================
# Helpers
# =============================================================================


def _hash_for(algorithm: str):
    if algorithm == "sha256":
        return hashlib.sha256
    if algorithm == "sha1":
        return hashlib.sha1
    if algorithm == "sha512":
        return hashlib.sha512
    raise ValueError(f"Unsupported HMAC algorithm: {algorithm!r}")


def _header_get(
    headers: Mapping[str, str] | Any, name: str
) -> str | None:
    """Case-insensitive header lookup that tolerates plain dicts."""
    if headers is None:
        return None
    try:
        # Starlette / httpx Headers expose case-insensitive get().
        v = headers.get(name)  # type: ignore[union-attr]
    except AttributeError:
        v = None
    if v is not None:
        return v
    target = name.casefold()
    items = headers.items() if hasattr(headers, "items") else []
    for k, val in items:
        if str(k).casefold() == target:
            return str(val)
    return None


def _parse_kv_csv(value: str) -> dict[str, list[str]]:
    """Parse ``a=1,b=2,a=3`` -> ``{'a': ['1', '3'], 'b': ['2']}``.

    Whitespace around keys/values is stripped. Entries without ``=`` are
    ignored. Used by the ``kv_csv`` signature scheme (PagerDuty,
    Stripe-shaped headers).
    """
    out: dict[str, list[str]] = {}
    for part in value.split(","):
        part = part.strip()
        if not part or "=" not in part:
            continue
        k, v = part.split("=", 1)
        out.setdefault(k.strip(), []).append(v.strip())
    return out


def _validate_timestamp_window(
    raw: str, window: int, *, header_name: str
) -> float:
    """Parse + range-check a Unix-seconds timestamp header.

    Mirrors the legacy ``_validate_timestamp`` in routes.webhooks so
    error messages stay byte-identical for the github adapter.
    """
    try:
        ts = float(raw)
    except (TypeError, ValueError) as exc:
        raise HTTPException(
            status_code=400,
            detail=f"{header_name} must be a numeric epoch",
        ) from exc

    if not math.isfinite(ts):
        raise HTTPException(
            status_code=400,
            detail=f"{header_name} must be a finite number",
        )

    now = time.time()
    if abs(now - ts) > window:
        raise HTTPException(
            status_code=401,
            detail=f"Webhook timestamp outside ±{window}s replay window",
        )
    return ts


# =============================================================================
# Loader + registry
# =============================================================================


_DEFAULT_RESOURCE = "webhook_providers.yaml"
_adapters: dict[str, WebhookAdapter] = {}


def _resolve_path(path: Path | str | None) -> Path | None:
    if path is None:
        return None
    p = Path(path)
    return p


def _read_yaml(path: Path | None) -> dict[str, Any]:
    if path is not None:
        if not path.is_file():
            raise FileNotFoundError(
                f"webhook_providers file not found: {path}"
            )
        with path.open("r", encoding="utf-8") as f:
            data = yaml.safe_load(f) or {}
    else:
        # Bundled default. importlib.resources is the supported
        # cross-platform way to read package data files; works with
        # both editable installs and built wheels.
        with (
            resources.files("autonomous_agents")
            .joinpath(_DEFAULT_RESOURCE)
            .open("r", encoding="utf-8")
        ) as f:
            data = yaml.safe_load(f) or {}
    if not isinstance(data, dict):
        raise ValueError(
            "webhook_providers YAML must be a mapping at the root"
        )
    return data


def _parse_adapter(provider_id: str, raw: dict[str, Any]) -> WebhookAdapter:
    sig_raw = raw.get("signature") or {}
    if not isinstance(sig_raw, dict):
        raise ValueError(f"provider {provider_id!r}: signature must be a mapping")

    scheme = sig_raw.get("scheme", "prefixed_hex")
    if scheme not in {"prefixed_hex", "kv_csv", "raw_base64"}:
        raise ValueError(
            f"provider {provider_id!r}: unknown signature.scheme={scheme!r}"
        )
    algorithm = sig_raw.get("algorithm", "sha256")
    if algorithm not in {"sha256", "sha1", "sha512"}:
        raise ValueError(
            f"provider {provider_id!r}: unsupported algorithm={algorithm!r}"
        )
    encoding = sig_raw.get("encoding", "hex")
    if encoding not in {"hex", "base64"}:
        raise ValueError(
            f"provider {provider_id!r}: unsupported encoding={encoding!r}"
        )
    header = sig_raw.get("header")
    if not header:
        raise ValueError(f"provider {provider_id!r}: signature.header required")

    keys = sig_raw.get("signature_keys") or []
    if not isinstance(keys, list):
        raise ValueError(
            f"provider {provider_id!r}: signature.signature_keys must be a list"
        )

    sig = _SignatureSpec(
        header=str(header),
        scheme=str(scheme),
        algorithm=str(algorithm),
        encoding=str(encoding),
        prefix=sig_raw.get("prefix"),
        signature_keys=tuple(str(k) for k in keys),
        timestamp_key=sig_raw.get("timestamp_key"),
    )

    ts_raw = raw.get("timestamp")
    ts: _TimestampSpec | None = None
    if ts_raw:
        if not isinstance(ts_raw, dict):
            raise ValueError(
                f"provider {provider_id!r}: timestamp must be a mapping"
            )
        ts = _TimestampSpec(
            header=ts_raw.get("header"),
            fmt=str(ts_raw.get("format", "unix_seconds")),
            bind_into_payload=bool(ts_raw.get("bind_into_payload", False)),
            required=bool(ts_raw.get("required", False)),
            tolerance_seconds=(
                int(ts_raw["tolerance_seconds"])
                if ts_raw.get("tolerance_seconds") is not None
                else None
            ),
            from_signature_header=bool(
                ts_raw.get("from_signature_header", False)
            ),
        )

    ping_raw = raw.get("ping")
    ping: _PingSpec | None = None
    if ping_raw:
        if not isinstance(ping_raw, dict):
            raise ValueError(
                f"provider {provider_id!r}: ping must be a mapping"
            )
        ping = _PingSpec(
            header=str(ping_raw["header"]),
            value=str(ping_raw["value"]),
        )

    return WebhookAdapter(
        provider_id=provider_id,
        signature=sig,
        timestamp=ts,
        payload_template=str(raw.get("payload_template", "{body}")),
        timestamped_payload_template=raw.get("timestamped_payload_template"),
        ping=ping,
        default_dedup_header=raw.get("dedup_header"),
    )


def load_adapters(
    path: Path | str | None = None,
) -> dict[str, WebhookAdapter]:
    """Parse a webhook_providers YAML and install the registry.

    Called once at lifespan start with ``Settings.webhook_providers_file``
    (``None`` => bundled default). Subsequent calls replace the
    registry atomically — useful for hot reloads in dev / tests.
    """
    resolved = _resolve_path(path)
    raw = _read_yaml(resolved)
    providers_section = raw.get("providers")
    if not isinstance(providers_section, dict) or not providers_section:
        raise ValueError(
            "webhook_providers YAML must define a non-empty 'providers' "
            "mapping"
        )

    parsed: dict[str, WebhookAdapter] = {}
    for pid, body in providers_section.items():
        if not isinstance(body, dict):
            raise ValueError(f"provider {pid!r}: definition must be a mapping")
        parsed[str(pid)] = _parse_adapter(str(pid), body)

    _adapters.clear()
    _adapters.update(parsed)
    logger.info(
        "Loaded %d webhook adapter(s): %s",
        len(parsed),
        ", ".join(sorted(parsed.keys())),
    )
    return dict(parsed)


def set_adapters(adapters: Mapping[str, WebhookAdapter]) -> None:
    """Replace the registry directly. Tests use this to bypass YAML I/O."""
    _adapters.clear()
    _adapters.update(adapters)


def get_adapter(provider: str) -> WebhookAdapter:
    """Look up an adapter by provider id; raise 500 if unknown.

    A 500 (rather than 404) is intentional: an unknown provider id
    means the operator misconfigured a task — the webhook URL exists
    but the YAML doesn't describe how to verify it. Senders should
    not be told their delivery is invalid; the operator should fix
    the config.
    """
    if not _adapters:
        # Lazy bootstrap for unit tests / scripts that don't go through
        # the lifespan. Loads the bundled defaults.
        load_adapters()
    adapter = _adapters.get(provider)
    if adapter is None:
        raise HTTPException(
            status_code=500,
            detail=(
                f"Unknown webhook provider {provider!r}; configure it in "
                "webhook_providers.yaml or set WEBHOOK_PROVIDERS_FILE."
            ),
        )
    return adapter


def reset_adapters() -> None:
    """Clear the registry. Tests call this between cases."""
    _adapters.clear()
