"""is_bot_sender: user-token posts via an app (bot_id + human user) are human."""
import pytest

from utils import utils


@pytest.fixture
def bots_info(monkeypatch):
    def _set(name, user_id):
        monkeypatch.setattr(utils, "get_bot_info_by_id", lambda _b: (name, user_id))
    return _set


def test_no_bot_id_is_human():
    assert utils.is_bot_sender({"user": "U1"}) is False


def test_workflow_bot_without_user_is_bot():
    assert utils.is_bot_sender({"bot_id": "B1"}) is True


def test_app_bot_user_matches_is_bot(bots_info):
    bots_info("GitLab", "UBOT")
    assert utils.is_bot_sender({"bot_id": "B1", "user": "UBOT"}) is True


def test_user_token_post_via_app_is_human(bots_info):
    bots_info("dev-login", "")
    assert utils.is_bot_sender({"bot_id": "B1", "user": "WHUMAN"}) is False


def test_user_differs_from_bot_user_is_human(bots_info):
    bots_info("SomeApp", "UBOT")
    assert utils.is_bot_sender({"bot_id": "B1", "user": "UHUMAN"}) is False


def test_bots_info_failure_fails_safe_to_bot(bots_info):
    bots_info("", "")
    assert utils.is_bot_sender({"bot_id": "B1", "user": "UHUMAN"}) is True
