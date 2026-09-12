from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest
import requests

from deepeval_eval.clients.search_rag import (
    SearchRagClient,
    build_search_rag_client,
    check_response,
    extract_contexts_and_sources,
)


def test_check_response_positive() -> None:
    mock_resp = MagicMock(spec=requests.Response)
    mock_resp.ok = True
    result = check_response(mock_resp)
    assert result == mock_resp


def test_check_response_negative() -> None:
    mock_resp = MagicMock(spec=requests.Response)
    mock_resp.ok = False
    mock_resp.status_code = 404
    mock_resp.request = MagicMock()
    mock_resp.request.method = "GET"
    mock_resp.request.url = "http://example.com"
    mock_resp.text = "Not Found"

    with pytest.raises(RuntimeError, match="HTTP 404"):
        check_response(mock_resp)


def test_extract_contexts_and_sources_positive() -> None:
    raw_results = [
        {
            "document": {
                "page_content": "Paris is the capital of France.",
                "metadata": {
                    "document_id": "doc100",
                    "title": "France Info",
                    "metadata": {"source_type": "pdf"},
                },
            },
            "score": 0.95,
        }
    ]
    contexts, sources = extract_contexts_and_sources(raw_results)
    assert contexts == ["Paris is the capital of France."]
    assert sources == [
        {
            "document_id": "doc100",
            "title": "France Info",
            "source_type": "pdf",
            "score": 0.95,
        }
    ]


def test_extract_contexts_and_sources_negative() -> None:
    # Empty content or invalid structures
    raw_results = [
        {"document": {"metadata": {}}},
        {"invalid": "structure"},
        {},
    ]
    contexts, sources = extract_contexts_and_sources(raw_results)
    assert contexts == []
    assert sources == []


def test_caipe_rag_client_refresh_access_token_positive() -> None:
    mock_resp = MagicMock(spec=requests.Response)
    mock_resp.ok = True
    mock_resp.status_code = 200
    mock_resp.json.return_value = {
        "access_token": "new_access_token",
        "expires_in": 600,
    }
    mock_resp.raise_for_status = MagicMock()

    with patch("requests.post", return_value=mock_resp):
        client = SearchRagClient(
            base_url="https://rag.example.org/api",
            keycloak_url="https://keycloak.example.org/token",
            client_id="test_client",
            client_secret="test_secret",
        )
        assert client.session.headers["Authorization"] == "Bearer new_access_token"


def test_search_rag_client_refresh_access_token_negative() -> None:
    with patch.dict("os.environ", {}, clear=True):
        client = SearchRagClient(base_url="https://rag.example.org/api")
        assert "Authorization" not in client.session.headers


def test_search_rag_client_refresh_access_token_failure() -> None:
    mock_resp = MagicMock(spec=requests.Response)
    mock_resp.ok = False
    mock_resp.status_code = 500
    mock_resp.raise_for_status.side_effect = requests.HTTPError("Server error")

    with patch("requests.post", return_value=mock_resp):
        with pytest.raises(RuntimeError, match="Failed to fetch OIDC token"):
            SearchRagClient(
                base_url="https://rag.example.org/api",
                keycloak_url="https://keycloak.example.org/token",
                client_id="test_client",
                client_secret="test_secret",
            )


def test_search_rag_client_query_raw_positive() -> None:
    client = SearchRagClient(
        base_url="https://rag.example.org/api", token="static_token"
    )
    mock_resp = MagicMock()
    mock_resp.ok = True
    mock_resp.json.return_value = [
        {"document": {"page_content": "Content"}, "score": 0.9}
    ]

    with patch.object(client.session, "post", return_value=mock_resp):
        res = client.query_raw("query text", datasource_id="ds1", limit=3)
        assert len(res) == 1
        assert res[0]["score"] == 0.9


def test_search_rag_client_query_raw_metadata_filters() -> None:
    client = SearchRagClient(
        base_url="https://rag.example.org/api", token="static_token"
    )
    mock_resp = MagicMock()
    mock_resp.ok = True
    mock_resp.json.return_value = []

    with patch.object(client.session, "post", return_value=mock_resp) as mock_post:
        client.query_raw(
            "query text",
            datasource_id="ds1",
            limit=3,
            metadata_filters={"metadata.source_type": "pdf"},
        )
        assert mock_post.called
        payload = mock_post.call_args[1]["json"]
        assert payload["filters"] == {
            "datasource_id": "ds1",
            "metadata.source_type": "pdf",
        }


def test_search_rag_client_query_positive() -> None:
    client = SearchRagClient(
        base_url="https://rag.example.org/api", token="static_token"
    )
    mock_llm = MagicMock()
    mock_llm.input_tokens = 0
    mock_llm.output_tokens = 0
    mock_llm.total_tokens = 0

    def mock_generate(prompt: str) -> str:
        mock_llm.input_tokens += 50
        mock_llm.output_tokens += 20
        mock_llm.total_tokens += 70
        return "Generated answer"

    mock_llm.generate.side_effect = mock_generate

    raw_results = [
        {
            "document": {
                "page_content": "Context info",
                "metadata": {"document_id": "doc1"},
            }
        }
    ]

    with patch.object(client, "query_raw", return_value=raw_results):
        res = client.query("What is X?", llm_client=mock_llm)
        assert res.answer == "Generated answer"
        assert res.contexts == ["Context info"]
        assert res.retrieved_doc_ids == ["doc1"]
        assert res.input_tokens == 50
        assert res.output_tokens == 20
        assert res.total_tokens == 70


def test_search_rag_client_query_negative() -> None:
    client = SearchRagClient(
        base_url="https://rag.example.org/api", token="static_token"
    )

    with patch.object(client, "query_raw", return_value=[]):
        with pytest.raises(ValueError, match="llm_client is required"):
            client.query("What is X?", llm_client=None)


def test_search_rag_client_prompt_style_query() -> None:
    client = SearchRagClient(
        base_url="https://rag.example.org/api", token="static_token"
    )
    mock_llm = MagicMock()
    mock_llm.generate.return_value = "Short Answer"

    raw_results = [
        {
            "document": {
                "page_content": "Short context",
                "metadata": {"document_id": "hp1"},
            }
        }
    ]
    with patch.object(client, "query_raw", return_value=raw_results):
        res = client.query("What is Y?", prompt_style="short", llm_client=mock_llm)
        assert res.answer == "Short Answer"
        assert res.retrieved_doc_ids == ["hp1"]
        assert mock_llm.generate.called
        assert "Keep the answer short" in mock_llm.generate.call_args[0][0]


def test_build_search_rag_client_positive(monkeypatch) -> None:
    monkeypatch.setenv("CAIPE_BASE_URL", "http://localhost:8080")
    monkeypatch.setenv("CAIPE_AUTH_TOKEN", "token123")
    monkeypatch.setenv("INSECURE_SSL", "true")
    client = build_search_rag_client()
    assert isinstance(client, SearchRagClient)
    assert client.base_url == "http://localhost:8080"
    assert client.session.verify is False


def test_query_raw_when_response_is_dict_with_results_parses_list() -> None:
    client = SearchRagClient(
        base_url="https://rag.example.org/api", token="static_token"
    )
    mock_resp = MagicMock()
    mock_resp.ok = True
    mock_resp.json.return_value = {"results": [{"document": {"page_content": "hello"}}]}

    with patch.object(client.session, "post", return_value=mock_resp):
        res = client.query_raw(
            "query without filters", datasource_id=None, limit=5, metadata_filters=None
        )
        assert len(res) == 1
        assert res[0]["document"]["page_content"] == "hello"


def test_query_raw_when_response_is_unexpected_type_returns_empty_list() -> None:
    client = SearchRagClient(
        base_url="https://rag.example.org/api", token="static_token"
    )
    mock_resp = MagicMock()
    mock_resp.ok = True
    mock_resp.json.return_value = "unexpected string format"

    with patch.object(client.session, "post", return_value=mock_resp):
        res = client.query_raw("query", datasource_id=None, limit=5)
        assert res == []


def test_query_when_llm_tokens_are_strings_and_floats_converts_safely() -> None:
    client = SearchRagClient(
        base_url="https://rag.example.org/api",
        token="static_token",
        prompt_args={"custom_param": "default_val"},
    )
    mock_llm = MagicMock()
    mock_llm.input_tokens = "10.0"
    mock_llm.output_tokens = "invalid_token_str"
    mock_llm.total_tokens = 5.5
    mock_llm.generate.return_value = "Parsed tokens answer"

    with patch.object(client, "query_raw", return_value=[]):
        res = client.query(
            "Question?",
            llm_client=mock_llm,
            prompt_args={"custom_param": "override_val"},
        )
        assert res.answer == "Parsed tokens answer"
        assert res.input_tokens >= 0
        assert res.output_tokens == 0
