import asyncio
import importlib.util
from pathlib import Path
from types import ModuleType
from typing import Callable
from unittest.mock import AsyncMock, Mock

import pytest


@pytest.fixture
def completed_process() -> Callable[..., Mock]:
    def make(stdout: bytes = b"", stderr: bytes = b"", returncode: int = 0) -> Mock:
        readers = []
        for data in (stdout, stderr):
            reader = asyncio.StreamReader()
            reader.feed_data(data)
            reader.feed_eof()
            readers.append(reader)
        return Mock(stdout=readers[0], stderr=readers[1], returncode=returncode, wait=AsyncMock(return_value=returncode))
    return make


@pytest.fixture
def server(monkeypatch: pytest.MonkeyPatch) -> ModuleType:
    spec = importlib.util.spec_from_file_location("aws_account_server", Path(__file__).parents[1] / "server.py")
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    monkeypatch.setenv("AWS_ACCOUNT_LIST", "primary:000000000001,secondary:000000000002")
    module._aws_cli_semaphore = asyncio.Semaphore(1)
    module._kubectl_semaphore = asyncio.Semaphore(1)
    return module
