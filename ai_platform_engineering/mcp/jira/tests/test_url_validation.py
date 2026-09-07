# Copyright 2025 CAIPE Contributors
# SPDX-License-Identifier: Apache-2.0
# assisted-by claude code claude-sonnet-4-6

"""Tests for Jira MCP URL hostname validation (example.com placeholder detection)."""

from unittest.mock import patch


class TestJiraClientURLValidation:
    """Tests for validate_prerequisites URL check in mcp_jira/api/client.py."""

    def _call_validate(self, url: str):
        with patch.dict("os.environ", {
            "ATLASSIAN_TOKEN": "real-token",
            "ATLASSIAN_EMAIL": "user@real.com",
            "ATLASSIAN_API_URL": url,
        }):
            from api.client import validate_prerequisites
            return validate_prerequisites()

    def test_real_atlassian_url_accepted(self):
        ok, _ = self._call_validate("https://mycompany.atlassian.net")
        assert ok is True

    def test_example_com_rejected(self):
        ok, result = self._call_validate("https://example.com")
        assert ok is False
        assert "Invalid" in result.get("error", "")

    def test_jira_example_com_rejected(self):
        ok, result = self._call_validate("https://jira.example.com")
        assert ok is False
        assert "Invalid" in result.get("error", "")

    def test_subdomain_of_example_com_rejected(self):
        ok, result = self._call_validate("https://mycompany.example.com")
        assert ok is False

    def test_no_false_positive_example_in_path(self):
        # example.com appears only in the path, not the hostname
        ok, _ = self._call_validate("https://mycompany.atlassian.net/example.com/page")
        assert ok is True


class TestJiraSearchURLValidation:
    """Tests for example.com check in mcp_jira/tools/jira/search.py."""

    def _env_with_url(self, url: str):
        return {
            "ATLASSIAN_TOKEN": "real-token",
            "ATLASSIAN_EMAIL": "user@real.com",
            "ATLASSIAN_API_URL": url,
        }

    def test_example_com_returns_error_string(self):
        from unittest.mock import patch
        with patch.dict("os.environ", self._env_with_url("https://example.com")):
            from tools.jira.search import search_jira_issues
            result = search_jira_issues(jql="project = TEST")
            assert "Error" in result or "Invalid" in result

    def test_real_url_passes_validation_stage(self):
        from unittest.mock import patch
        with patch.dict("os.environ", self._env_with_url("https://mycompany.atlassian.net")):
            with patch("api.client.validate_prerequisites", return_value=(True, {})):
                with patch("api.client.make_api_request", return_value=(True, {"issues": [], "total": 0})):
                    from tools.jira.search import search_jira_issues
                    result = search_jira_issues(jql="project = TEST")
                    assert "Error" not in result
