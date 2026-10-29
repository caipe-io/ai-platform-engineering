"""Reply size boundaries preserve original text and keep continuation links visible."""

import pytest

from ai_platform_engineering.integrations.webex_bot.utils.message_limits import (
    WEBEX_MESSAGE_MAX_BYTES,
    bounded_markdown,
)


@pytest.mark.parametrize('body', ['a' * 10000, '😀' * 3000, '漢字' * 3000])
@pytest.mark.parametrize('opening,closing', [('', ''), ('```python\n', '\n```\n'), ('~~~\n', '\n~~~\n'), ('`', '\n`\n')])
def test_truncated_reply_preserves_prefix_and_closes_code(body: str, opening: str, closing: str) -> None:
    footer = '\n\nAgent: Example'
    notice = '\n\n[Full response](https://chat.example.com/chat/' + 'a' * 200 + ')'
    source = opening + body
    reply = bounded_markdown(source, footer=footer, notice=notice)
    assert len(reply.encode('utf-8')) <= WEBEX_MESSAGE_MAX_BYTES
    assert reply.endswith(closing + notice + footer)
    prefix = reply.removesuffix(closing + notice + footer)
    assert source.startswith(prefix)
    assert '\ufffd' not in reply


def test_exact_byte_boundary_keeps_complete_reply() -> None:
    footer = '\n\nAgent: Example'
    body = 'a' * (WEBEX_MESSAGE_MAX_BYTES - len(footer.encode('utf-8')))
    assert bounded_markdown(body, footer=footer, notice='truncated') == body + footer
    assert 'truncated' in bounded_markdown(body + 'a', footer=footer, notice='truncated')
