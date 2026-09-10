from __future__ import annotations

from unittest.mock import Mock

import pytest

from server import restapi


def test_create_redis_client_disables_socket_timeout(monkeypatch: pytest.MonkeyPatch) -> None:
  client = object()
  from_url = Mock(return_value=client)
  monkeypatch.setattr(restapi.redis, "from_url", from_url)

  assert restapi.create_redis_client("redis://example.test:6379") is client
  from_url.assert_called_once_with(
    "redis://example.test:6379",
    decode_responses=True,
    socket_timeout=None,
  )
