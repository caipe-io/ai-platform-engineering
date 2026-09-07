import socket

import pytest

from common.utils import generate_confluence_datasource_id, sanitize_url


def _patch_dns(monkeypatch, records: dict[str, list[str]]) -> None:
  def fake_getaddrinfo(hostname, port, *args, **kwargs):
    return [
      (
        socket.AF_INET6 if ":" in ip else socket.AF_INET,
        socket.SOCK_STREAM,
        6,
        "",
        (ip, port or 0),
      )
      for ip in records[hostname]
    ]

  monkeypatch.setattr("common.utils.socket.getaddrinfo", fake_getaddrinfo)


def test_sanitize_url_allows_global_addresses(monkeypatch):
  _patch_dns(monkeypatch, {"docs.example.com": ["93.184.216.34"]})

  assert sanitize_url("docs.example.com/guide") == "https://docs.example.com/guide"


@pytest.mark.parametrize(
  "resolved_ip",
  [
    "169.254.169.254",
    "100.64.0.1",
    "fc00::1",
    "::",
  ],
)
def test_sanitize_url_rejects_non_global_resolved_addresses(monkeypatch, resolved_ip):
  _patch_dns(monkeypatch, {"metadata.example.com": [resolved_ip]})

  with pytest.raises(ValueError, match="publicly routable"):
    sanitize_url("https://metadata.example.com/latest/meta-data")


def test_sanitize_url_rejects_mixed_global_and_private_dns_answers(monkeypatch):
  _patch_dns(monkeypatch, {"docs.example.com": ["93.184.216.34", "10.1.2.3"]})

  with pytest.raises(ValueError, match="publicly routable"):
    sanitize_url("https://docs.example.com")


def test_sanitize_url_rejects_loopback(monkeypatch):
  _patch_dns(monkeypatch, {"localhost.example.com": ["127.0.0.1"]})

  with pytest.raises(ValueError, match="publicly routable"):
    sanitize_url("https://localhost.example.com/api")


def test_sanitize_url_rejects_ipv6_loopback(monkeypatch):
  _patch_dns(monkeypatch, {"host.example.com": ["::1"]})

  with pytest.raises(ValueError, match="publicly routable"):
    sanitize_url("https://host.example.com/api")


def test_sanitize_url_rejects_unresolvable_hostname(monkeypatch):
  def fail_resolve(*args, **kwargs):
    raise socket.gaierror("Name or service not known")

  monkeypatch.setattr("common.utils.socket.getaddrinfo", fail_resolve)

  with pytest.raises(ValueError, match="could not be resolved"):
    sanitize_url("https://nonexistent.invalid/page")


def test_sanitize_url_allows_private_when_flag_set(monkeypatch):
  _patch_dns(monkeypatch, {"internal.example.com": ["10.1.2.3"]})

  result = sanitize_url("https://internal.example.com/docs", allow_non_public_urls=True)
  assert result == "https://internal.example.com/docs"


def test_generate_confluence_datasource_id_preserves_legacy_space_identity():
  assert generate_confluence_datasource_id(
    "https://wiki.example.com/confluence",
    "ENG",
  ) == "src_confluence___wiki_example_com__ENG"


def test_generate_confluence_datasource_id_scopes_ui_source_to_root_page():
  assert generate_confluence_datasource_id(
    "https://wiki.example.com/confluence",
    "ENG",
    "123456",
  ) == "src_confluence___wiki_example_com__ENG__123456"


def test_generate_confluence_datasource_id_makes_page_source_safe_for_managed_access():
  assert generate_confluence_datasource_id(
    "https://wiki.example.com:8090/confluence",
    "Control Plane",
    "123456",
  ) == "src_confluence___wiki_example_com_8090__Control_Plane__123456"
