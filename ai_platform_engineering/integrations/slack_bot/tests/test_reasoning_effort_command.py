from ai_platform_engineering.integrations.slack_bot.utils.reasoning_effort import (
    PendingEffortKey,
    PendingEffortStore,
)
from ai_platform_engineering.integrations.slack_bot.utils.slash_commands import handle_effort_command


def test_effort_command_stages_next_dm_effort() -> None:
    store = PendingEffortStore()
    key = PendingEffortKey("workspace", "direct", "user")

    result = handle_effort_command(
        user_key="user",
        raw_text="high",
        is_dm=True,
        pending_key=key,
        pending_store=store,
    )

    assert result.code == "effort_ok"
    assert store.consume(key) == "high"


def test_effort_command_is_dm_only() -> None:
    result = handle_effort_command(
        user_key="user",
        raw_text="high",
        is_dm=False,
        pending_key=None,
        pending_store=PendingEffortStore(),
    )

    assert result.code == "dm_only"
