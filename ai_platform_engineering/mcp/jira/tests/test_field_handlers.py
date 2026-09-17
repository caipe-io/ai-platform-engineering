"""Unit tests for field type handlers."""

import pytest
from datetime import datetime, date
from utils.field_handlers import (
    normalize_field_value,
    _normalize_string_field,
    _normalize_number_field,
    _normalize_date_field,
    _normalize_user_field,
    _normalize_array_field,
    _normalize_option_field,
    _normalize_adf_field
)


class TestNormalizeStringField:
    """Tests for string field normalization."""

    def test_string_input(self):
        """Test normalizing string input."""
        result = _normalize_string_field("Hello")
        assert result == "Hello"

    def test_number_to_string(self):
        """Test converting number to string."""
        result = _normalize_string_field(123)
        assert result == "123"


class TestNormalizeNumberField:
    """Tests for number field normalization."""

    def test_integer_input(self):
        """Test normalizing integer."""
        result = _normalize_number_field(42)
        assert result == 42
        assert isinstance(result, int)

    def test_float_input(self):
        """Test normalizing float."""
        result = _normalize_number_field(3.14)
        assert result == 3.14
        assert isinstance(result, float)

    def test_string_to_integer(self):
        """Test converting string to integer."""
        result = _normalize_number_field("42")
        assert result == 42

    def test_string_to_float(self):
        """Test converting string with decimal to float."""
        result = _normalize_number_field("3.14")
        assert result == 3.14

    def test_invalid_string(self):
        """Test handling invalid number string."""
        with pytest.raises(ValueError):
            _normalize_number_field("not a number")


class TestNormalizeDateField:
    """Tests for date field normalization."""

    def test_string_date(self):
        """Test normalizing date string."""
        result = _normalize_date_field("2025-12-31")
        assert result == "2025-12-31"

    def test_datetime_object(self):
        """Test converting datetime to date string."""
        dt = datetime(2025, 12, 31, 15, 30)
        result = _normalize_date_field(dt)
        assert result == "2025-12-31"

    def test_date_object(self):
        """Test converting date object to string."""
        d = date(2025, 12, 31)
        result = _normalize_date_field(d)
        assert result == "2025-12-31"


class TestNormalizeUserField:
    """Tests for user field normalization."""

    def test_dict_with_account_id(self):
        """Test user dict with accountId."""
        result = _normalize_user_field({"accountId": "123abc"})
        assert result == {"accountId": "123abc"}

    def test_dict_with_id(self):
        """Test user dict with id field."""
        result = _normalize_user_field({"id": "123abc"})
        assert result == {"accountId": "123abc"}

    def test_string_as_account_id(self):
        """Test string interpreted as accountId."""
        result = _normalize_user_field("123abc")
        assert result == {"accountId": "123abc"}

    def test_dict_with_name(self):
        """Test legacy username format."""
        result = _normalize_user_field({"name": "john.doe"})
        assert result == {"name": "john.doe"}


class TestNormalizeArrayField:
    """Tests for array field normalization."""

    def test_list_input(self):
        """Test normalizing existing list."""
        result = _normalize_array_field(["item1", "item2"])
        assert result == ["item1", "item2"]

    def test_single_item_to_list(self):
        """Test converting single item to list."""
        result = _normalize_array_field("single item")
        assert result == ["single item"]

    def test_string_array_items(self):
        """Test normalizing array with string items."""
        result = _normalize_array_field([1, 2, 3], items_type="string")
        assert result == ["1", "2", "3"]


class TestNormalizeOptionField:
    """Tests for option field normalization."""

    def test_dict_with_value(self):
        """Test option dict with value."""
        result = _normalize_option_field({"value": "High"})
        assert result == {"value": "High"}

    def test_string_to_option(self):
        """Test converting string to option dict."""
        result = _normalize_option_field("High")
        assert result == {"value": "High"}


class TestNormalizeADFField:
    """Tests for ADF field normalization."""

    def test_string_to_adf(self):
        """Test converting plain text to ADF."""
        result = _normalize_adf_field("Hello World")
        
        assert result["version"] == 1
        assert result["type"] == "doc"
        assert "content" in result

    def test_existing_adf(self):
        """Test passing through existing ADF."""
        adf = {
            "version": 1,
            "type": "doc",
            "content": [
                {
                    "type": "paragraph",
                    "content": [{"type": "text", "text": "Hello"}]
                }
            ]
        }
        result = _normalize_adf_field(adf)
        assert result == adf

    def test_malformed_adf_is_not_passed_through(self):
        """Malformed ADF dictionaries should be normalized instead of trusted."""
        malformed_adf = {
            "version": 1,
            "type": "doc",
            "content": "not-a-list",
        }

        result = _normalize_adf_field(malformed_adf)

        assert result != malformed_adf
        assert result["type"] == "doc"
        assert isinstance(result["content"], list)


class TestNormalizeFieldValue:
    """Tests for main normalize_field_value function."""

    @pytest.mark.asyncio
    async def test_normalize_none_value(self):
        """Test that None values pass through."""
        value, error = await normalize_field_value("test_field", None, None)
        assert value is None
        assert error is None

    @pytest.mark.asyncio
    async def test_normalize_string_field(self):
        """Test normalizing string field type."""
        schema = {"type": "string"}
        value, error = await normalize_field_value("summary", "Test Summary", schema)
        
        assert value == "Test Summary"
        assert error is None

    @pytest.mark.asyncio
    async def test_normalize_number_field(self):
        """Test normalizing number field type."""
        schema = {"type": "number"}
        value, error = await normalize_field_value("storypoints", "5", schema)
        
        assert value == 5
        assert error is None

    @pytest.mark.asyncio
    async def test_normalize_user_field(self):
        """Test normalizing user field type."""
        schema = {"type": "user"}
        value, error = await normalize_field_value("assignee", "account-123", schema)
        
        assert value == {"accountId": "account-123"}
        assert error is None

    @pytest.mark.asyncio
    async def test_normalize_array_field(self):
        """Test normalizing array field type."""
        schema = {"type": "array", "items": "string"}
        value, error = await normalize_field_value("labels", ["bug", "urgent"], schema)
        
        assert value == ["bug", "urgent"]
        assert error is None

    @pytest.mark.asyncio
    async def test_normalize_with_error(self):
        """Test error handling in normalization."""
        schema = {"type": "number"}
        value, error = await normalize_field_value("field", "not_a_number", schema)
        
        assert error is not None
        assert "Cannot convert" in error

    @pytest.mark.asyncio
    async def test_normalize_without_schema(self):
        """Test normalization without schema (pass-through)."""
        value, error = await normalize_field_value("test_field", "test_value", None)
        
        assert value == "test_value"
        assert error is None

    @pytest.mark.asyncio
    async def test_normalize_unknown_type(self):
        """Test normalization with unknown field type."""
        schema = {"type": "unknown_type"}
        value, error = await normalize_field_value("field", "value", schema)
        
        # Should pass through with warning
        assert value == "value"
        assert error is None
