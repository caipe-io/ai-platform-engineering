#!/usr/bin/env python3
"""One-shot OpenFGA seed: store (idempotent), authorization model, optional tuples.

Besides the store + model, this seeds the platform service account as an
organization auditor. CAS's subject-binding requires the caller to hold
`can_audit` on the org before it will evaluate a decision for a different
subject — the on-behalf-of flow the autonomous-agents scheduler uses to run
tasks as their owners. Without this tuple every autonomous run fails with a
403 from the CAS decisions endpoint.
"""

from __future__ import annotations

import base64
import json
import os
import sys
import time
from pathlib import Path

import httpx

OPENFGA = os.environ.get("OPENFGA_HTTP", "http://openfga:8080").rstrip("/")
STORE_NAME = os.environ.get("OPENFGA_STORE_NAME", "caipe-openfga").strip()
SEED_OBJECT = os.environ.get("OPENFGA_SEED_OBJECT", "mcp_gateway:list").strip()
SEED_RELATION = os.environ.get("OPENFGA_SEED_RELATION", "caller").strip()
SEED_SUB = os.environ.get("OPENFGA_SEED_SUB", "").strip()

# Platform service-account -> org auditor grant (autonomous OBO delegation).
KEYCLOAK_TOKEN_URL = os.environ.get("KEYCLOAK_TOKEN_URL", "").strip()
PLATFORM_CLIENT_ID = os.environ.get("KEYCLOAK_PLATFORM_CLIENT_ID", "").strip()
PLATFORM_CLIENT_SECRET = os.environ.get("KEYCLOAK_PLATFORM_CLIENT_SECRET", "").strip()
ORG_OBJECT = os.environ.get("OPENFGA_ORG_OBJECT", "organization:caipe").strip()


def wait_ready() -> None:
    for i in range(60):
        try:
            r = httpx.get(f"{OPENFGA}/stores", timeout=2.0)
            if r.status_code == 200:
                return
        except httpx.HTTPError:
            pass
        time.sleep(1)
        print(f"waiting for OpenFGA ({i + 1}/60)...", file=sys.stderr)
    sys.exit("OpenFGA did not become ready")


def platform_service_account_sub(client: httpx.Client) -> str:
    """Resolve the Keycloak `sub` of the platform client's service account.

    The `sub` is instance-specific (regenerated with the realm), so it cannot
    be a static seed value — mint a client-credentials token and read it from
    the claims. Retries because the realm import may still be settling even
    after Keycloak's healthcheck passes.
    """
    last_error: Exception | None = None
    for attempt in range(30):
        try:
            r = client.post(
                KEYCLOAK_TOKEN_URL,
                data={
                    "grant_type": "client_credentials",
                    "client_id": PLATFORM_CLIENT_ID,
                    "client_secret": PLATFORM_CLIENT_SECRET,
                },
            )
            r.raise_for_status()
            token = r.json()["access_token"]
            payload = token.split(".")[1]
            payload += "=" * (-len(payload) % 4)
            claims = json.loads(base64.urlsafe_b64decode(payload))
            sub = str(claims.get("sub", "")).strip()
            if sub:
                return sub
            last_error = ValueError("token has no sub claim")
        except (httpx.HTTPError, ValueError, KeyError) as exc:
            last_error = exc
        time.sleep(2)
        print(f"waiting for Keycloak token ({attempt + 1}/30)...", file=sys.stderr)
    sys.exit(f"could not resolve platform service-account sub: {last_error}")


def ensure_tuple(client: httpx.Client, store_id: str, tuple_key: dict[str, str]) -> None:
    """Write a tuple unless an equivalent grant already holds (idempotent)."""
    r = client.post(f"{OPENFGA}/stores/{store_id}/check", json={"tuple_key": tuple_key})
    r.raise_for_status()
    label = f"{tuple_key['user']} {tuple_key['relation']} {tuple_key['object']}"
    if r.json().get("allowed"):
        print(f"tuple already present for {label}")
        return
    r = client.post(
        f"{OPENFGA}/stores/{store_id}/write",
        json={"writes": {"tuple_keys": [tuple_key]}},
    )
    r.raise_for_status()
    print(f"tuple written for {label}")


def main() -> None:
    wait_ready()

    with httpx.Client(timeout=60.0) as client:
        r = client.get(f"{OPENFGA}/stores")
        r.raise_for_status()
        stores = r.json().get("stores", [])
        store_id = next((s["id"] for s in stores if s.get("name") == STORE_NAME), None)
        if not store_id:
            r = client.post(f"{OPENFGA}/stores", json={"name": STORE_NAME})
            r.raise_for_status()
            store_id = r.json()["id"]
            print(f"created store_id={store_id}")
        else:
            print(f"reusing store_id={store_id}")

        model_path = Path(__file__).resolve().parent / "authorization-model.json"
        model_body = json.loads(model_path.read_text())
        r = client.post(
            f"{OPENFGA}/stores/{store_id}/authorization-models",
            json=model_body,
        )
        r.raise_for_status()
        model_id = r.json()["authorization_model_id"]
        print(f"authorization_model_id={model_id}")

        if SEED_SUB:
            ensure_tuple(client, store_id, {
                "user": f"user:{SEED_SUB}",
                "relation": SEED_RELATION,
                "object": SEED_OBJECT,
            })
        else:
            print(
                "OPENFGA_SEED_SUB not set — no dev allow tuple written; "
                "set it to your Keycloak `sub` and re-run: "
                "docker compose ... run --rm openfga-init",
                file=sys.stderr,
            )

        if KEYCLOAK_TOKEN_URL and PLATFORM_CLIENT_ID and PLATFORM_CLIENT_SECRET:
            sub = platform_service_account_sub(client)
            ensure_tuple(client, store_id, {
                "user": f"service_account:{sub}",
                "relation": "auditor",
                "object": ORG_OBJECT,
            })
        else:
            print(
                "KEYCLOAK_TOKEN_URL / KEYCLOAK_PLATFORM_CLIENT_ID / "
                "KEYCLOAK_PLATFORM_CLIENT_SECRET not set — platform "
                "service-account auditor grant not seeded; autonomous "
                "on-behalf-of runs will be rejected by CAS subject-binding.",
                file=sys.stderr,
            )


if __name__ == "__main__":
    main()
