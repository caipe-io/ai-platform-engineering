import asyncio
import importlib.util
from pathlib import Path
from types import ModuleType

import pytest


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
