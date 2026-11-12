"""Read opted-in Services and ready EndpointSlices through the in-cluster API."""

import asyncio
import re
import ssl
from pathlib import Path

import httpx

from dynamic_agents.services.a2a_limits import A2ABoundedTransport

SERVICE_ACCOUNT = Path("/var/run/secrets/kubernetes.io/serviceaccount")
DNS_LABEL = re.compile(r"^[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?$")


async def _list_resources(client: httpx.AsyncClient, path: str, selector: str = "") -> list[dict]:
    items: list[dict] = []
    cursor = ""
    for _ in range(10):
        response = await client.get(path, params={"limit": 100, "continue": cursor, "labelSelector": selector})
        response.raise_for_status()
        payload = response.json()
        items.extend(payload.get("items", []))
        cursor = payload.get("metadata", {}).get("continue", "")
        if not cursor:
            return items
    raise ValueError("Discovery exceeds 1000 resources; narrow the configured namespace")


def service_candidates(services: list[dict], slices: list[dict], namespace: str, domain: str) -> list[dict]:
    ready: set[str] = set()
    for item in slices:
        if any(endpoint.get("conditions", {}).get("ready") is not False for endpoint in item.get("endpoints", [])):
            ready.add(item.get("metadata", {}).get("labels", {}).get("kubernetes.io/service-name", ""))
    results: list[dict] = []
    for service in services:
        metadata, spec = service.get("metadata", {}), service.get("spec", {})
        name = metadata.get("name", "")
        if not DNS_LABEL.fullmatch(name) or spec.get("type") == "ExternalName":
            continue
        if metadata.get("labels", {}).get("caipe.io/a2a-discovery") != "true":
            continue
        path = metadata.get("annotations", {}).get("caipe.io/a2a-path", "")
        if path and (not path.startswith("/") or not re.fullmatch(r"/[A-Za-z0-9_./-]*", path) or ".." in path or "//" in path):
            continue
        for port in spec.get("ports", []):
            if port.get("name") not in {"a2a", "a2a-https"} or port.get("protocol", "TCP") != "TCP":
                continue
            number = port.get("port")
            if not isinstance(number, int) or not 1 <= number <= 65535:
                continue
            scheme = "https" if port["name"] == "a2a-https" else "http"
            results.append({"endpoint": f"{scheme}://{name}.{namespace}.svc.{domain}:{number}{path}",
                "name": name, "namespace": namespace, "ready": name in ready})
    return results


async def discover_services(namespace: str, namespaces: list[str], domain: str) -> list[dict]:
    if namespace not in namespaces or not DNS_LABEL.fullmatch(namespace):
        raise ValueError("Choose a configured discovery namespace")
    if not all(DNS_LABEL.fullmatch(part) for part in domain.split(".")):
        raise ValueError("Invalid Kubernetes cluster domain")
    # The Kubernetes token never enters an Agent Card request or API response.
    token = (SERVICE_ACCOUNT / "token").read_text().strip()
    context = ssl.create_default_context(cafile=str(SERVICE_ACCOUNT / "ca.crt"))
    transport = A2ABoundedTransport(2 * 1024 * 1024, httpx.AsyncHTTPTransport(verify=context))
    async with asyncio.timeout(15), httpx.AsyncClient(base_url="https://kubernetes.default.svc", transport=transport,
        headers={"Authorization": f"Bearer {token}"}, follow_redirects=False, timeout=5) as client:
        services = await _list_resources(client, f"/api/v1/namespaces/{namespace}/services", "caipe.io/a2a-discovery=true")
        slices = await _list_resources(client, f"/apis/discovery.k8s.io/v1/namespaces/{namespace}/endpointslices")
    return service_candidates(services, slices, namespace, domain)
