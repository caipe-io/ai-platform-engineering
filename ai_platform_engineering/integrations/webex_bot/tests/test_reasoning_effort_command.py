from ai_platform_engineering.integrations.webex_bot.utils.reasoning_effort import PendingEffortStore
from ai_platform_engineering.integrations.webex_bot.utils.text_commands import (
    CommandIntent,
    handle_effort_command,
    parse_command_text,
)


def test_parse_effort_command() -> None:
    parsed = parse_command_text("effort max")

    assert parsed.intent is CommandIntent.EFFORT
    assert parsed.argument == "max"


def test_effort_command_stages_next_direct_message() -> None:
    store = PendingEffortStore()

    result = handle_effort_command(
        user_key="user",
        raw_text="low",
        is_dm=True,
        person_id="person",
        space_id="space",
        pending_store=store,
    )

    assert result.code == "effort_ok"
    assert store.consume("person", "space") == "low"
