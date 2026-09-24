from __future__ import annotations

from unittest.mock import MagicMock, patch

import httpx
import pytest
from pydantic import BaseModel

from deepeval_eval.clients.llm import (
    DeepEvalJudge,
    OpenAICompatibleClient,
    is_transient_error,
    make_generation_prompt,
    make_short_answer_prompt,
    parse_schema_response,
    with_json_schema_instruction,
)


class SampleSchema(BaseModel):
    answer: str
    confidence: float


def test_is_transient_error_positive() -> None:
    # 500 error is transient
    mock_response = MagicMock(spec=httpx.Response)
    mock_response.status_code = 500
    err = httpx.HTTPStatusError(
        "Server Error", request=MagicMock(), response=mock_response
    )
    assert is_transient_error(err) is True

    # 403 error is transient (e.g. auth lag)
    mock_response.status_code = 403
    err_403 = httpx.HTTPStatusError(
        "Forbidden", request=MagicMock(), response=mock_response
    )
    assert is_transient_error(err_403) is True


def test_is_transient_error_negative() -> None:
    # 400 bad request is not transient
    mock_response = MagicMock(spec=httpx.Response)
    mock_response.status_code = 400
    err = httpx.HTTPStatusError(
        "Bad Request", request=MagicMock(), response=mock_response
    )
    assert is_transient_error(err) is False

    # 401 unauthorized is not transient
    mock_response.status_code = 401
    err_401 = httpx.HTTPStatusError(
        "Unauthorized", request=MagicMock(), response=mock_response
    )
    assert is_transient_error(err_401) is False


def test_openai_compatible_client_positive() -> None:
    client = OpenAICompatibleClient(
        model="test-model", api_key="test-key", base_url="http://localhost:8000/v1"
    )
    assert client.input_tokens == 0

    mock_resp = MagicMock()
    mock_resp.json.return_value = {
        "choices": [{"message": {"content": "Hello World"}}],
        "usage": {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15},
    }

    with patch("httpx.Client.post", return_value=mock_resp):
        res = client.generate("Say hi")
        assert res == "Hello World"
        assert client.input_tokens == 10
        assert client.output_tokens == 5
        assert client.total_tokens == 15

    client.reset_tokens()
    assert client.input_tokens == 0


def test_openai_compatible_client_negative() -> None:
    client = OpenAICompatibleClient(
        model="test-model", api_key="test-key", base_url="http://localhost:8000/v1"
    )

    mock_resp = MagicMock()
    mock_resp.raise_for_status.side_effect = httpx.HTTPStatusError(
        "400 Bad Request", request=MagicMock(), response=MagicMock(status_code=400)
    )

    with patch("httpx.Client.post", return_value=mock_resp):
        with pytest.raises(httpx.HTTPStatusError):
            client.generate("Bad request prompt")


def test_deepeval_judge_adapter() -> None:
    client = OpenAICompatibleClient(
        model="test-model", api_key="test-key", base_url="http://localhost:8000"
    )
    judge = DeepEvalJudge("custom", "test-model", client)
    assert judge.model.get_model_name() == "custom:test-model"
    assert judge.model.load_model() == client


def test_with_json_schema_instruction_positive() -> None:
    prompt = "Extract details"
    result = with_json_schema_instruction(prompt, SampleSchema)
    assert prompt in result
    assert "Return only valid JSON matching this JSON schema" in result
    assert "confidence" in result


def test_parse_schema_response_positive() -> None:
    raw_json = '{"answer": "Paris", "confidence": 0.95}'
    parsed = parse_schema_response(raw_json, SampleSchema)
    assert parsed.answer == "Paris"
    assert parsed.confidence == 0.95

    markdown_json = '```json\n{"answer": "London", "confidence": 0.8}\n```'
    parsed_md = parse_schema_response(markdown_json, SampleSchema)
    assert parsed_md.answer == "London"
    assert parsed_md.confidence == 0.8


def test_parse_schema_response_negative() -> None:
    invalid_json = "This is not valid json at all"
    with pytest.raises(Exception):
        parse_schema_response(invalid_json, SampleSchema)


def test_make_generation_prompt_positive() -> None:
    prompt = make_generation_prompt("What is X?", ["Context 1", "Context 2"])
    assert "Question:\nWhat is X?" in prompt
    assert "[1] Context 1" in prompt
    assert "[2] Context 2" in prompt


def test_make_generation_prompt_negative() -> None:
    prompt = make_generation_prompt("What is X?", [])
    assert "Context:\n\n" in prompt


def test_make_short_answer_prompt_positive() -> None:
    prompt = make_short_answer_prompt("Who is Y?", ["Context line"])
    assert "Keep the answer short" in prompt
    assert "Question:\nWho is Y?" in prompt


def test_openai_compatible_client_context_manager_and_del() -> None:
    client = OpenAICompatibleClient(
        model="test-model", api_key="test-key", base_url="http://localhost:8000/v1"
    )
    with client as c:
        _ = c.client
        assert c._client is not None and not c._client.is_closed
    assert client._client.is_closed
    del client


def test_generate_with_pydantic_schema_returns_validated_instance() -> None:
    client = OpenAICompatibleClient(
        model="test-model", api_key="test-key", base_url="http://localhost:8000/v1"
    )
    mock_resp = MagicMock()
    mock_resp.json.return_value = {
        "choices": [
            {"message": {"content": '{"answer": "Tokyo", "confidence": 0.99}'}}
        ],
        "usage": None,
    }
    with patch("httpx.Client.post", return_value=mock_resp):
        res = client.generate("What is the capital?", schema=SampleSchema)
        assert isinstance(res, SampleSchema)
        assert res.answer == "Tokyo"
        assert res.confidence == 0.99


@pytest.mark.asyncio
async def test_deepeval_judge_async_generate_returns_response() -> None:
    client = OpenAICompatibleClient(
        model="test-model", api_key="test-key", base_url="http://localhost:8000/v1"
    )
    mock_resp = MagicMock()
    mock_resp.json.return_value = {
        "choices": [{"message": {"content": "Async response"}}],
        "usage": {},
    }
    with patch("httpx.Client.post", return_value=mock_resp):
        judge = DeepEvalJudge("custom", "test-model", client)
        res = await judge.model.a_generate("Async prompt")
        assert res == "Async response"


def test_parse_schema_response_when_json_embedded_in_text_extracts_via_regex() -> None:
    raw_text = 'Here is the result:\n```\n{"answer": "Berlin", "confidence": 0.9}```'
    parsed = parse_schema_response(raw_text, SampleSchema)
    assert parsed.answer == "Berlin"

    surrounded_text = (
        'Analysis result: {"answer": "Rome", "confidence": 0.85} end of message.'
    )
    parsed_surrounded = parse_schema_response(surrounded_text, SampleSchema)
    assert parsed_surrounded.answer == "Rome"
