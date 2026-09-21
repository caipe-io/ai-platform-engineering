"""
Tests for EmbeddingsFactory
"""

import os
import pytest
from unittest.mock import patch, MagicMock
from common.embeddings_factory import EmbeddingsFactory


class TestEmbeddingsFactory:
  """Test suite for EmbeddingsFactory"""

  def test_default_provider_azure_openai(self):
    """Test that default provider is azure-openai"""
    with patch.dict(os.environ, {}, clear=True):
      with patch("common.embeddings_factory.AzureOpenAIEmbeddings") as mock_azure:
        mock_instance = MagicMock()
        mock_azure.return_value = mock_instance

        result = EmbeddingsFactory.get_embeddings()

        mock_azure.assert_called_once_with(model="text-embedding-3-small")
        assert result == mock_instance

  def test_custom_model(self):
    """Test custom model configuration"""
    with patch.dict(os.environ, {"EMBEDDINGS_PROVIDER": "azure-openai", "EMBEDDINGS_MODEL": "text-embedding-3-large"}):
      with patch("common.embeddings_factory.AzureOpenAIEmbeddings") as mock_azure:
        mock_instance = MagicMock()
        mock_azure.return_value = mock_instance

        EmbeddingsFactory.get_embeddings()

        mock_azure.assert_called_once_with(model="text-embedding-3-large")

  def test_openai_provider(self):
    """Test OpenAI provider"""
    with patch.dict(os.environ, {"EMBEDDINGS_PROVIDER": "openai", "OPENAI_API_KEY": "test-key"}):
      with patch("common.embeddings_factory.OpenAIEmbeddings") as mock_openai:
        mock_instance = MagicMock()
        mock_openai.return_value = mock_instance

        result = EmbeddingsFactory.get_embeddings()

        mock_openai.assert_called_once()
        assert result == mock_instance

  def test_openai_missing_api_key(self):
    """Test OpenAI provider fails without API key"""
    with patch.dict(os.environ, {"EMBEDDINGS_PROVIDER": "openai"}, clear=True):
      with pytest.raises(ValueError, match="OPENAI_API_KEY"):
        EmbeddingsFactory.get_embeddings()

  def test_bedrock_provider(self):
    """Test AWS Bedrock provider"""
    with patch.dict(os.environ, {"EMBEDDINGS_PROVIDER": "aws-bedrock", "AWS_REGION": "us-west-2"}):
      with patch("langchain_aws.BedrockEmbeddings") as mock_bedrock:
        mock_instance = MagicMock()
        mock_bedrock.return_value = mock_instance

        result = EmbeddingsFactory.get_embeddings()

        mock_bedrock.assert_called_once_with(model_id="amazon.titan-embed-text-v2:0", region_name="us-west-2")
        assert result == mock_instance

  def test_unsupported_provider(self):
    """Test unsupported provider raises error"""
    with patch.dict(os.environ, {"EMBEDDINGS_PROVIDER": "invalid-provider"}):
      with pytest.raises(ValueError, match="Unsupported embeddings provider"):
        EmbeddingsFactory.get_embeddings()

  def test_get_embedding_dimensions(self):
    """Test embedding dimensions retrieval"""
    with patch.dict(os.environ, {"EMBEDDINGS_MODEL": "text-embedding-3-small"}):
      dimensions = EmbeddingsFactory.get_embedding_dimensions()
      assert dimensions == 1536

    with patch.dict(os.environ, {"EMBEDDINGS_MODEL": "text-embedding-3-large"}):
      dimensions = EmbeddingsFactory.get_embedding_dimensions()
      assert dimensions == 3072

    # Test unknown model returns default
    with patch.dict(os.environ, {"EMBEDDINGS_MODEL": "unknown-model"}):
      dimensions = EmbeddingsFactory.get_embedding_dimensions()
      assert dimensions == 1536  # default

  def test_litellm_provider_requires_api_base(self):
    """Test LiteLLM provider fails without LITELLM_API_BASE"""
    with patch.dict(os.environ, {"EMBEDDINGS_PROVIDER": "litellm", "EMBEDDINGS_MODEL": "azure/text-embedding-3-small"}, clear=True):
      with pytest.raises(ValueError, match="LITELLM_API_BASE"):
        EmbeddingsFactory.get_embeddings()

  def test_litellm_provider_with_proxy(self):
    """Test LiteLLM proxy mode uses OpenAIEmbeddings with correct params"""
    with patch.dict(os.environ, {"EMBEDDINGS_PROVIDER": "litellm", "EMBEDDINGS_MODEL": "azure/text-embedding-3-small", "LITELLM_API_KEY": "test-api-key", "LITELLM_API_BASE": "https://my-proxy.example.com"}):
      with patch("common.embeddings_factory.OpenAIEmbeddings") as mock_openai:
        mock_instance = MagicMock()
        mock_openai.return_value = mock_instance

        result = EmbeddingsFactory.get_embeddings()

        # Verify OpenAIEmbeddings was called with proxy params
        mock_openai.assert_called_once_with(
          model="azure/text-embedding-3-small",
          api_key="test-api-key",
          base_url="https://my-proxy.example.com",
        )
        assert result == mock_instance

  def test_litellm_provider_default_api_key(self):
    """Test LiteLLM provider uses default api_key when not provided"""
    with patch.dict(os.environ, {"EMBEDDINGS_PROVIDER": "litellm", "EMBEDDINGS_MODEL": "azure/text-embedding-3-small", "LITELLM_API_BASE": "https://my-proxy.example.com"}, clear=True):
      with patch("common.embeddings_factory.OpenAIEmbeddings") as mock_openai:
        mock_instance = MagicMock()
        mock_openai.return_value = mock_instance

        result = EmbeddingsFactory.get_embeddings()

        # Verify OpenAIEmbeddings was called with default api_key
        mock_openai.assert_called_once_with(
          model="azure/text-embedding-3-small",
          api_key="not-needed",
          base_url="https://my-proxy.example.com",
        )
        assert result == mock_instance

  def test_ollama_dimensions(self):
    """Test dimension mappings for Ollama local models"""
    with patch.dict(os.environ, {"EMBEDDINGS_MODEL": "snowflake-arctic-embed2"}):
      assert EmbeddingsFactory.get_embedding_dimensions() == 1024

    with patch.dict(os.environ, {"EMBEDDINGS_MODEL": "nomic-embed-text"}):
      assert EmbeddingsFactory.get_embedding_dimensions() == 768

    with patch.dict(os.environ, {"EMBEDDINGS_MODEL": "mxbai-embed-large"}):
      assert EmbeddingsFactory.get_embedding_dimensions() == 1024

    with patch.dict(os.environ, {"EMBEDDINGS_MODEL": "bge-m3"}):
      assert EmbeddingsFactory.get_embedding_dimensions() == 1024

    with patch.dict(os.environ, {"EMBEDDINGS_MODEL": "qwen3-embedding:0.6b"}):
      assert EmbeddingsFactory.get_embedding_dimensions() == 1024

    with patch.dict(os.environ, {"EMBEDDINGS_MODEL": "qwen3-embedding:8b"}):
      assert EmbeddingsFactory.get_embedding_dimensions() == 4096

  def test_detect_dimensions_monkey_patch(self):
    """detect_dimensions can be patched so tests never need a live embedding service."""
    mock_embeddings = MagicMock()
    with patch.object(EmbeddingsFactory, "detect_dimensions", return_value=1024) as mock_detect:
      result = EmbeddingsFactory.detect_dimensions(mock_embeddings)
      assert result == 1024
      mock_detect.assert_called_once_with(mock_embeddings)

  def test_litellm_dimensions(self):
    """Test dimension mappings for LiteLLM models"""
    with patch.dict(os.environ, {"EMBEDDINGS_MODEL": "mistral/mistral-embed"}):
      assert EmbeddingsFactory.get_embedding_dimensions() == 1024

    with patch.dict(os.environ, {"EMBEDDINGS_MODEL": "gemini/text-embedding-004"}):
      assert EmbeddingsFactory.get_embedding_dimensions() == 768

    with patch.dict(os.environ, {"EMBEDDINGS_MODEL": "voyage/voyage-01"}):
      assert EmbeddingsFactory.get_embedding_dimensions() == 1024
