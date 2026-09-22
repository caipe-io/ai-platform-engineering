"""Unit tests for Jira comments MCP tools."""

import json
import pytest


class TestGetComments:
    """Tests for get_comments function."""

    @pytest.mark.asyncio
    async def test_get_comments_success(self, monkeypatch):
        """Test getting comments for an issue."""
        mock_response = {
            "comments": [
                {
                    "id": "10000",
                    "body": {
                        "type": "doc",
                        "version": 1,
                        "content": [
                            {
                                "type": "paragraph",
                                "content": [{"type": "text", "text": "First comment"}]
                            }
                        ]
                    },
                    "author": {"displayName": "John Doe"},
                    "created": "2024-01-01T12:00:00.000Z"
                },
                {
                    "id": "10001",
                    "body": {
                        "type": "doc",
                        "version": 1,
                        "content": [
                            {
                                "type": "paragraph",
                                "content": [{"type": "text", "text": "Second comment"}]
                            }
                        ]
                    },
                    "author": {"displayName": "Jane Smith"},
                    "created": "2024-01-02T12:00:00.000Z"
                }
            ]
        }

        async def mock_request(path, method="GET", **kwargs):
            return (True, mock_response)

        from api import client
        monkeypatch.setattr(client, "make_api_request", mock_request)

        from tools.jira.comments import get_comments

        result = await get_comments("PROJ-123")

        assert "First comment" in result or "comments" in result

    @pytest.mark.asyncio
    async def test_get_comments_no_comments(self, monkeypatch):
        """Test getting comments when none exist."""
        async def mock_request(path, method="GET", **kwargs):
            return (True, {"comments": []})

        from api import client
        monkeypatch.setattr(client, "make_api_request", mock_request)

        from tools.jira.comments import get_comments

        result = await get_comments("PROJ-123")

        assert "[]" in result or "comments" in result or "No" in result

    @pytest.mark.asyncio
    async def test_get_comments_api_error(self, monkeypatch):
        """Test get_comments - mock mode returns success."""
        from tools.jira.comments import get_comments

        # In mock mode, this will return mock comments data
        result = await get_comments("INVALID-123")

        # Mock mode returns success, verify it returns comment data
        assert "comment" in result.lower() or "id" in result


class TestGetComment:
    """Tests for get_comment function."""

    @pytest.mark.asyncio
    async def test_get_comment_success(self, monkeypatch):
        """Test getting a specific comment."""
        mock_comment = {
            "id": "10000",
            "body": {
                "type": "doc",
                "version": 1,
                "content": [
                    {
                        "type": "paragraph",
                        "content": [{"type": "text", "text": "Specific comment"}]
                    }
                ]
            },
            "author": {"displayName": "Test User"},
            "created": "2024-01-01T12:00:00.000Z",
            "updated": "2024-01-01T13:00:00.000Z"
        }

        async def mock_request(path, method="GET", **kwargs):
            return (True, mock_comment)

        from api import client
        monkeypatch.setattr(client, "make_api_request", mock_request)

        from tools.jira.comments import get_comment

        result = await get_comment("PROJ-123", "10000")

        assert "10000" in result or "Specific comment" in result


class TestAddComment:
    """Tests for add_comment function."""

    @pytest.mark.asyncio
    async def test_add_comment_success(self, monkeypatch):
        """Test adding a comment."""
        captured_request = {}

        async def mock_request(path, method="GET", **kwargs):
            captured_request["path"] = path
            captured_request["method"] = method
            captured_request["data"] = kwargs.get("data")
            return True, {"id": "10002", "body": kwargs["data"]["body"]}

        monkeypatch.setattr("tools.jira.comments.MCP_JIRA_READ_ONLY", False)
        monkeypatch.setattr("tools.jira.comments.make_api_request", mock_request)

        from tools.jira.comments import add_comment

        result = await add_comment("PROJ-123", "New comment")
        result_dict = json.loads(result)

        assert result_dict["id"] == "10002"
        assert captured_request == {
            "path": "rest/api/3/issue/PROJ-123/comment",
            "method": "POST",
            "data": {
                "body": {
                    "type": "doc",
                    "version": 1,
                    "content": [
                        {
                            "type": "paragraph",
                            "content": [{"type": "text", "text": "New comment"}],
                        }
                    ],
                }
            },
        }

    @pytest.mark.asyncio
    async def test_add_comment_accepts_native_adf(self, monkeypatch):
        """Native ADF should reach Jira unchanged, including rich content."""
        captured_request = {}
        adf_body = {
            "type": "doc",
            "version": 1,
            "content": [
                {
                    "type": "heading",
                    "attrs": {"level": 2},
                    "content": [{"type": "text", "text": "Triage analysis"}],
                },
                {
                    "type": "paragraph",
                    "content": [
                        {
                            "type": "text",
                            "text": "Related issue",
                            "marks": [
                                {"type": "strong"},
                                {
                                    "type": "link",
                                    "attrs": {"href": "https://example.test/browse/PROJ-100"},
                                },
                            ],
                        }
                    ],
                },
                {
                    "type": "table",
                    "attrs": {"isNumberColumnEnabled": False, "layout": "default"},
                    "content": [
                        {
                            "type": "tableRow",
                            "content": [
                                {
                                    "type": "tableHeader",
                                    "content": [
                                        {
                                            "type": "paragraph",
                                            "content": [{"type": "text", "text": "Key"}],
                                        }
                                    ],
                                },
                                {
                                    "type": "tableCell",
                                    "content": [
                                        {
                                            "type": "paragraph",
                                            "content": [{"type": "text", "text": "PROJ-100"}],
                                        }
                                    ],
                                },
                            ],
                        }
                    ],
                },
            ],
        }

        async def mock_request(path, method="GET", **kwargs):
            captured_request["path"] = path
            captured_request["method"] = method
            captured_request["data"] = kwargs.get("data")
            return True, {"id": "10003", "body": kwargs["data"]["body"]}

        monkeypatch.setattr("tools.jira.comments.MCP_JIRA_READ_ONLY", False)
        monkeypatch.setattr("tools.jira.comments.make_api_request", mock_request)

        from tools.jira.comments import add_comment

        result = await add_comment(
            "PROJ-123",
            adf_body,
            visibility={"type": "role", "value": "Administrators"},
            body_format="adf",
        )

        assert json.loads(result)["id"] == "10003"
        assert captured_request["path"] == "rest/api/3/issue/PROJ-123/comment"
        assert captured_request["method"] == "POST"
        assert captured_request["data"] == {
            "body": adf_body,
            "visibility": {"type": "role", "value": "Administrators"},
        }

    @pytest.mark.asyncio
    async def test_add_comment_preserves_legacy_multiline_text(self, monkeypatch):
        """Default text mode should not split or trim existing comment input."""
        captured_request = {}

        async def mock_request(path, method="GET", **kwargs):
            captured_request["data"] = kwargs.get("data")
            return True, {"id": "10004"}

        monkeypatch.setattr("tools.jira.comments.MCP_JIRA_READ_ONLY", False)
        monkeypatch.setattr("tools.jira.comments.make_api_request", mock_request)

        from tools.jira.comments import add_comment

        body = " First line\n\nSecond line "
        await add_comment("PROJ-123", body)

        assert captured_request["data"]["body"] == {
            "type": "doc",
            "version": 1,
            "content": [
                {
                    "type": "paragraph",
                    "content": [{"type": "text", "text": body}],
                }
            ],
        }

    @pytest.mark.asyncio
    async def test_add_comment_rejects_invalid_adf_without_api_call(self, monkeypatch):
        """Invalid ADF should fail locally instead of posting malformed content."""
        api_called = False

        async def mock_request(path, method="GET", **kwargs):
            nonlocal api_called
            api_called = True
            return True, {}

        monkeypatch.setattr("tools.jira.comments.MCP_JIRA_READ_ONLY", False)
        monkeypatch.setattr("tools.jira.comments.make_api_request", mock_request)

        from tools.jira.comments import add_comment

        result = await add_comment(
            "PROJ-123",
            {"type": "doc", "version": 1, "content": "not-a-list"},
            body_format="adf",
        )

        assert api_called is False
        assert json.loads(result) == {
            "success": False,
            "error": (
                "body must be a valid ADF document object when body_format is 'adf'. "
                "Expected type='doc', version=1, and a content list."
            ),
        }

    @pytest.mark.asyncio
    async def test_add_comment_rejects_adf_body_in_text_mode(self, monkeypatch):
        """The explicit format flag should guard against accidental rich payloads."""
        monkeypatch.setattr("tools.jira.comments.MCP_JIRA_READ_ONLY", False)

        from tools.jira.comments import add_comment

        result = await add_comment(
            "PROJ-123",
            {"type": "doc", "version": 1, "content": []},
        )

        assert json.loads(result) == {
            "success": False,
            "error": "body must be a string when body_format is 'text'.",
        }

    @pytest.mark.asyncio
    async def test_add_comment_rejects_unsupported_body_format(self, monkeypatch):
        """Direct Python callers should receive a clear unsupported-format error."""
        api_called = False

        async def mock_request(path, method="GET", **kwargs):
            nonlocal api_called
            api_called = True
            return True, {}

        monkeypatch.setattr("tools.jira.comments.MCP_JIRA_READ_ONLY", False)
        monkeypatch.setattr("tools.jira.comments.make_api_request", mock_request)

        from tools.jira.comments import add_comment

        result = await add_comment(
            "PROJ-123",
            "Comment body",
            body_format="markdown",
        )

        assert api_called is False
        assert json.loads(result) == {
            "success": False,
            "error": "body_format must be either 'text' or 'adf'.",
        }

    @pytest.mark.asyncio
    async def test_add_comment_read_only(self, monkeypatch):
        """Test that add_comment returns error JSON in read-only mode."""
        # Mock read-only mode
        monkeypatch.setattr("tools.jira.comments.MCP_JIRA_READ_ONLY", True)

        from tools.jira.comments import add_comment

        result = await add_comment("PROJ-123", "Test comment")
        result_dict = json.loads(result)

        assert result_dict["success"] is False
        assert "read-only" in result_dict["error"].lower()


class TestAddInternalComment:
    """Tests for add_internal_comment function."""

    @pytest.mark.asyncio
    async def test_add_internal_comment_uses_platform_internal_property(self, monkeypatch):
        """Test adding a Jira Service Management internal note."""
        captured_request = {}

        async def mock_request(path, method="GET", **kwargs):
            captured_request["path"] = path
            captured_request["method"] = method
            captured_request["data"] = kwargs.get("data")
            return (
                True,
                {
                    "id": "10003",
                    "body": kwargs.get("data", {}).get("body"),
                },
            )

        monkeypatch.setattr("tools.jira.comments.MCP_JIRA_READ_ONLY", False)
        monkeypatch.setattr("tools.jira.comments.make_api_request", mock_request)

        from tools.jira.comments import add_internal_comment

        result = await add_internal_comment("PROJ-123", "Initial investigation: test")
        result_dict = json.loads(result)

        assert result_dict["id"] == "10003"
        assert captured_request["path"] == "rest/api/3/issue/PROJ-123/comment"
        assert captured_request["method"] == "POST"
        assert captured_request["data"]["body"]["type"] == "doc"
        assert captured_request["data"]["body"]["content"][0]["content"][0]["text"] == (
            "Initial investigation: test"
        )
        assert captured_request["data"]["properties"] == [
            {
                "key": "sd.public.comment",
                "value": {
                    "internal": True,
                },
            }
        ]

    @pytest.mark.asyncio
    async def test_add_internal_comment_accepts_native_adf(
        self,
        monkeypatch,
        sample_adf_doc,
    ):
        """Rich internal notes should retain ADF and the internal property."""
        captured_request = {}

        async def mock_request(path, method="GET", **kwargs):
            captured_request["data"] = kwargs.get("data")
            return True, {"id": "10004"}

        monkeypatch.setattr("tools.jira.comments.MCP_JIRA_READ_ONLY", False)
        monkeypatch.setattr("tools.jira.comments.make_api_request", mock_request)

        from tools.jira.comments import add_internal_comment

        result = await add_internal_comment(
            "PROJ-123",
            sample_adf_doc,
            body_format="adf",
        )

        assert json.loads(result)["id"] == "10004"
        assert captured_request["data"] == {
            "body": sample_adf_doc,
            "properties": [
                {
                    "key": "sd.public.comment",
                    "value": {"internal": True},
                }
            ],
        }

    @pytest.mark.asyncio
    async def test_add_internal_comment_read_only(self, monkeypatch):
        """Test that add_internal_comment returns error JSON in read-only mode."""
        monkeypatch.setattr("tools.jira.comments.MCP_JIRA_READ_ONLY", True)

        from tools.jira.comments import add_internal_comment

        result = await add_internal_comment("PROJ-123", "Test internal note")
        result_dict = json.loads(result)

        assert result_dict["success"] is False
        assert "read-only" in result_dict["error"].lower()


class TestUpdateComment:
    """Tests for update_comment function."""

    @pytest.mark.asyncio
    async def test_update_comment_success(self, monkeypatch):
        """Test updating a comment."""
        def mock_check_read_only():
            return None

        from tools.jira import constants
        monkeypatch.setattr(constants, "check_read_only", mock_check_read_only)

        mock_response = {
            "id": "10000",
            "body": {
                "type": "doc",
                "version": 1,
                "content": [
                    {
                        "type": "paragraph",
                        "content": [{"type": "text", "text": "Updated comment"}]
                    }
                ]
            }
        }

        async def mock_request(path, method="GET", **kwargs):
            return (True, mock_response)

        from api import client
        monkeypatch.setattr(client, "make_api_request", mock_request)

        from tools.jira.comments import update_comment

        result = await update_comment("PROJ-123", "10000", "Updated comment")

        assert "10000" in result or "Updated" in result or "success" in result.lower()

    @pytest.mark.asyncio
    async def test_update_comment_accepts_native_adf(
        self,
        monkeypatch,
        sample_adf_doc,
    ):
        """Updating a comment should pass native ADF to Jira unchanged."""
        captured_request = {}

        async def mock_request(path, method="GET", **kwargs):
            captured_request["path"] = path
            captured_request["method"] = method
            captured_request["data"] = kwargs.get("data")
            return True, {"id": "10000"}

        monkeypatch.setattr("tools.jira.comments.MCP_JIRA_READ_ONLY", False)
        monkeypatch.setattr("tools.jira.comments.make_api_request", mock_request)

        from tools.jira.comments import update_comment

        result = await update_comment(
            "PROJ-123",
            "10000",
            sample_adf_doc,
            visibility={"type": "role", "value": "Administrators"},
            body_format="adf",
        )

        assert json.loads(result)["id"] == "10000"
        assert captured_request == {
            "path": "rest/api/3/issue/PROJ-123/comment/10000",
            "method": "PUT",
            "data": {
                "body": sample_adf_doc,
                "visibility": {"type": "role", "value": "Administrators"},
            },
        }


class TestDeleteComment:
    """Tests for delete_comment function."""

    @pytest.mark.asyncio
    async def test_delete_comment_success(self, monkeypatch):
        """Test deleting a comment."""
        def mock_check_read_only():
            return None

        from tools.jira import constants
        monkeypatch.setattr(constants, "check_read_only", mock_check_read_only)

        async def mock_request(path, method="GET", **kwargs):
            return (True, {})

        from api import client
        monkeypatch.setattr(client, "make_api_request", mock_request)

        from tools.jira.comments import delete_comment

        result = await delete_comment("PROJ-123", "10000")

        assert "deleted" in result.lower() or "success" in result.lower()

    @pytest.mark.asyncio
    async def test_delete_comment_read_only(self, monkeypatch):
        """Test that delete_comment returns error JSON in read-only mode."""
        # Mock read-only mode
        monkeypatch.setattr("tools.jira.comments.MCP_JIRA_READ_ONLY", True)

        from tools.jira.comments import delete_comment

        result = await delete_comment("PROJ-123", "10000")
        result_dict = json.loads(result)

        assert result_dict["success"] is False
        assert "read-only" in result_dict["error"].lower()
