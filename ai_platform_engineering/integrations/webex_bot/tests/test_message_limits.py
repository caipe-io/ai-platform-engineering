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


def test_line_preserving_truncation_keeps_complete_rows_and_closes_fence() -> None:
    footer = '\n\nAgent: Example'
    notice = '\n\n_Response truncated._'
    body = '```text\nHeader | State\n------+---------\nrow-1  | ready\nrow-2  | ready\n' + 'x' * 10000 + '\n```'

    reply = bounded_markdown(body, footer=footer, notice=notice, preserve_line_boundaries=True)

    assert len(reply.encode('utf-8')) <= WEBEX_MESSAGE_MAX_BYTES
    assert reply.endswith(notice + footer)
    assert reply.count('```') == 2
    assert 'row-1  | ready' in reply
    assert 'row-2  | ready' in reply
    assert 'x' * 100 not in reply


def test_block_preserving_truncation_keeps_complete_labeled_records() -> None:
    footer = '\n\nAgent: Example'
    notice = '\n\n_Response truncated._'
    body = (
        '```text\n'
        'Record: one\n  Region: example | Subnet: subnet-one\n\n'
        'Record: two\n  Region: example | Subnet: ' + 'x' * 10000 + '\n\n'
        'Record: three\n  Region: example | Subnet: subnet-three\n'
        '```'
    )

    reply = bounded_markdown(
        body,
        footer=footer,
        notice=notice,
        preserve_line_boundaries=True,
        preserve_block_boundaries=True,
    )

    assert len(reply.encode('utf-8')) <= WEBEX_MESSAGE_MAX_BYTES
    assert reply.endswith(notice + footer)
    assert reply.count('```') == 2
    assert 'Record: one' in reply
    assert 'Record: two' not in reply
    assert 'Record: three' not in reply


def test_block_preserving_truncation_drops_an_incomplete_first_record() -> None:
    footer = '\n\nAgent: Example'
    notice = '\n\n_Response truncated._'
    body = (
        '```text\n'
        'Record: ' + 'x' * 10000 + '\n'
        '  Region: example | Subnet: subnet-one\n\n'
        'Record: two\n  Region: example | Subnet: subnet-two\n'
        '```'
    )

    reply = bounded_markdown(
        body,
        footer=footer,
        notice=notice,
        preserve_line_boundaries=True,
        preserve_block_boundaries=True,
    )

    assert len(reply.encode('utf-8')) <= WEBEX_MESSAGE_MAX_BYTES
    assert reply.endswith(notice + footer)
    assert 'Record:' not in reply
    assert 'x' * 100 not in reply


def test_block_preserving_truncation_keeps_complete_lines_in_python_fence() -> None:
    footer = '\n\nAgent: Example'
    notice = '\n\n_Response truncated._'
    body = '```python\n' + 'print(1)\n' * 2000 + '```'

    reply = bounded_markdown(
        body,
        footer=footer,
        notice=notice,
        preserve_line_boundaries=True,
        preserve_block_boundaries=True,
    )

    assert len(reply.encode('utf-8')) <= WEBEX_MESSAGE_MAX_BYTES
    assert reply.startswith('```python\nprint(1)\n')
    assert reply.endswith('\n```\n' + notice + footer)
    assert 0 < reply.count('print(1)') < 2000


def test_truncation_closes_a_generated_fence_longer_than_three_backticks() -> None:
    footer = '\n\nAgent: Example'
    notice = '\n\n_Response truncated._'
    body = '````text\nValue\n-----\n```\n' + 'x' * 10000

    reply = bounded_markdown(body, footer=footer, notice=notice, preserve_line_boundaries=True)

    assert len(reply.encode('utf-8')) <= WEBEX_MESSAGE_MAX_BYTES
    assert reply.endswith('\n````\n' + notice + footer)
    assert reply.count('````') == 2
