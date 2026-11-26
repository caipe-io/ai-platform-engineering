from unittest.mock import Mock

from server import restapi


def test_create_storage_uses_shared_mongo_adapter(monkeypatch) -> None:
  client = object()
  factory = Mock(return_value=client)
  monkeypatch.setattr(restapi, "MongoStorage", factory)
  assert restapi.create_storage() is client
  factory.assert_called_once_with()
