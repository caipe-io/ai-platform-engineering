"""Unit tests for ADF (Atlassian Document Format) converter."""

import pytest

from utils.adf import (
    text_to_adf,
    adf_to_text,
    is_adf_format,
    ensure_adf_format,
    create_empty_adf,
    literal_text_to_adf,
    prepare_adf_input,
)


class TestTextToADF:
    """Tests for text_to_adf converter."""

    def test_single_paragraph(self):
        """Test converting single paragraph to ADF."""
        result = text_to_adf("Hello World")

        assert result["version"] == 1
        assert result["type"] == "doc"
        assert len(result["content"]) == 1
        assert result["content"][0]["type"] == "paragraph"
        assert result["content"][0]["content"][0]["text"] == "Hello World"

    def test_multiple_paragraphs(self):
        """Test converting multiple paragraphs to ADF."""
        result = text_to_adf("Hello\nWorld")

        assert len(result["content"]) == 2
        assert result["content"][0]["content"][0]["text"] == "Hello"
        assert result["content"][1]["content"][0]["text"] == "World"

    def test_empty_string(self):
        """Test converting empty string to ADF."""
        result = text_to_adf("")

        assert result["version"] == 1
        assert result["type"] == "doc"
        assert len(result["content"]) == 0

    def test_whitespace_only(self):
        """Test converting whitespace-only string to ADF."""
        result = text_to_adf("   \n   \n   ")

        # Should create empty paragraph for whitespace
        assert len(result["content"]) == 1


class TestADFToText:
    """Tests for adf_to_text converter."""

    def test_single_paragraph(self, sample_adf_doc):
        """Test converting ADF single paragraph to text."""
        result = adf_to_text(sample_adf_doc)
        assert result == "Hello World"

    def test_multiple_paragraphs(self):
        """Test converting ADF multiple paragraphs to text."""
        adf = {
            "version": 1,
            "type": "doc",
            "content": [
                {
                    "type": "paragraph",
                    "content": [{"type": "text", "text": "Para 1"}]
                },
                {
                    "type": "paragraph",
                    "content": [{"type": "text", "text": "Para 2"}]
                }
            ]
        }
        result = adf_to_text(adf)
        assert result == "Para 1\nPara 2"

    def test_empty_adf(self):
        """Test converting empty ADF to text."""
        adf = {"version": 1, "type": "doc", "content": []}
        result = adf_to_text(adf)
        assert result == ""

    def test_with_formatting(self):
        """Test converting ADF with text formatting."""
        adf = {
            "version": 1,
            "type": "doc",
            "content": [
                {
                    "type": "paragraph",
                    "content": [
                        {"type": "text", "text": "bold", "marks": [{"type": "strong"}]},
                        {"type": "text", "text": " "},
                        {"type": "text", "text": "italic", "marks": [{"type": "em"}]}
                    ]
                }
            ]
        }
        result = adf_to_text(adf)
        assert "**bold**" in result
        assert "*italic*" in result


class TestIsADFFormat:
    """Tests for is_adf_format checker."""

    def test_valid_adf(self, sample_adf_doc):
        """Test recognizing valid ADF."""
        assert is_adf_format(sample_adf_doc) is True

    def test_invalid_dict(self):
        """Test rejecting invalid dict."""
        assert is_adf_format({"random": "data"}) is False

    def test_missing_version(self):
        """Test rejecting ADF without version."""
        invalid = {"type": "doc", "content": []}
        assert is_adf_format(invalid) is False

    def test_content_must_be_a_list(self):
        """Test rejecting an ADF root with malformed content."""
        invalid = {"type": "doc", "version": 1, "content": "not-a-list"}
        assert is_adf_format(invalid) is False

    def test_wrong_type(self):
        """Test rejecting wrong type."""
        assert is_adf_format("not a dict") is False
        assert is_adf_format(123) is False
        assert is_adf_format(None) is False


class TestEnsureADFFormat:
    """Tests for ensure_adf_format."""

    def test_string_input(self):
        """Test converting string to ADF."""
        result = ensure_adf_format("Hello")

        assert result["version"] == 1
        assert result["type"] == "doc"
        assert result["content"][0]["content"][0]["text"] == "Hello"

    def test_adf_input(self, sample_adf_doc):
        """Test passing through existing ADF."""
        result = ensure_adf_format(sample_adf_doc)
        assert result == sample_adf_doc

    def test_invalid_input(self):
        """Test handling invalid input."""
        result = ensure_adf_format({"random": "data"})
        # Should create empty ADF for unknown format
        assert result["type"] == "doc"


class TestPrepareADFInput:
    """Tests for strict text-or-ADF input handling."""

    def test_text_uses_selected_converter(self):
        """Callers can preserve legacy single-paragraph comment behavior."""
        value = " First line\n\nSecond line "

        result = prepare_adf_input(
            value,
            "text",
            field_name="body",
            text_converter=literal_text_to_adf,
        )

        assert result["content"][0]["content"][0]["text"] == value

    def test_adf_is_preserved(self, sample_adf_doc):
        """Native ADF should pass through without transformation."""
        assert (
            prepare_adf_input(sample_adf_doc, "adf", field_name="description")
            == sample_adf_doc
        )

    @pytest.mark.parametrize(
        ("value", "value_format", "expected"),
        [
            ({"type": "doc", "version": 1, "content": []}, "text", "must be a string"),
            ("plain text", "adf", "must be a valid ADF document"),
            ("plain text", "markdown", "must be either 'text' or 'adf'"),
        ],
    )
    def test_invalid_input_is_rejected(self, value, value_format, expected):
        """Format mismatches should fail before reaching Jira."""
        with pytest.raises(ValueError, match=expected):
            prepare_adf_input(value, value_format, field_name="body")


class TestCreateEmptyADF:
    """Tests for create_empty_adf."""

    def test_create_empty(self):
        """Test creating empty ADF document."""
        result = create_empty_adf()

        assert result["version"] == 1
        assert result["type"] == "doc"
        assert result["content"] == []
