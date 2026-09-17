"""Atlassian Document Format (ADF) utilities.

This module provides utilities for converting between plain text and Jira's
Atlassian Document Format (ADF), which is used for rich text fields like
descriptions and comments.

Reference: https://developer.atlassian.com/cloud/jira/platform/apis/document/structure/
"""

import logging
from typing import Any, Dict, Union

logger = logging.getLogger("mcp-jira")


def text_to_adf(text: str) -> Dict[str, Any]:
    """Convert plain text to Atlassian Document Format (ADF).

    Args:
        text: Plain text string

    Returns:
        ADF document structure

    Example:
        >>> text_to_adf("Hello\\nWorld")
        {
            "version": 1,
            "type": "doc",
            "content": [
                {"type": "paragraph", "content": [{"type": "text", "text": "Hello"}]},
                {"type": "paragraph", "content": [{"type": "text", "text": "World"}]}
            ]
        }
    """
    if not text:
        return {
            "version": 1,
            "type": "doc",
            "content": []
        }

    # Split text into paragraphs (by double newline or single newline)
    paragraphs = text.split('\n')

    content = []
    for para in paragraphs:
        para = para.strip()
        if not para:
            # Empty paragraph
            continue

        # Create a paragraph node
        paragraph_content = []

        # Check for markdown-style formatting
        # Bold: **text** or __text__
        # Italic: *text* or _text_
        # Code: `text`
        # Links: [text](url)

        # For now, create simple text nodes
        # TODO: Add markdown parsing for formatting
        paragraph_content.append({
            "type": "text",
            "text": para
        })

        content.append({
            "type": "paragraph",
            "content": paragraph_content
        })

    # If no content was created (empty string or only whitespace), add empty paragraph
    if not content:
        content.append({
            "type": "paragraph",
            "content": []
        })

    return {
        "version": 1,
        "type": "doc",
        "content": content
    }


def adf_to_text(adf: Dict[str, Any]) -> str:
    """Convert Atlassian Document Format (ADF) to plain text.

    Args:
        adf: ADF document structure

    Returns:
        Plain text string

    Example:
        >>> adf_to_text({
        ...     "type": "doc",
        ...     "content": [
        ...         {"type": "paragraph", "content": [{"type": "text", "text": "Hello"}]},
        ...         {"type": "paragraph", "content": [{"type": "text", "text": "World"}]}
        ...     ]
        ... })
        'Hello\\nWorld'
    """
    if not adf or adf.get("type") != "doc":
        return ""

    content = adf.get("content", [])
    paragraphs = []

    for node in content:
        node_type = node.get("type")

        if node_type == "paragraph":
            para_text = _extract_paragraph_text(node)
            paragraphs.append(para_text)

        elif node_type == "codeBlock":
            code_text = _extract_code_block_text(node)
            paragraphs.append(f"```\n{code_text}\n```")

        elif node_type == "bulletList" or node_type == "orderedList":
            list_text = _extract_list_text(node, node_type == "orderedList")
            paragraphs.append(list_text)

        elif node_type == "heading":
            heading_text = _extract_heading_text(node)
            paragraphs.append(heading_text)

    return "\n".join(paragraphs)


def _extract_paragraph_text(node: Dict[str, Any]) -> str:
    """Extract text from a paragraph node."""
    content = node.get("content", [])
    text_parts = []

    for item in content:
        item_type = item.get("type")

        if item_type == "text":
            text = item.get("text", "")
            marks = item.get("marks", [])

            # Apply formatting marks
            for mark in marks:
                mark_type = mark.get("type")
                if mark_type == "strong":
                    text = f"**{text}**"
                elif mark_type == "em":
                    text = f"*{text}*"
                elif mark_type == "code":
                    text = f"`{text}`"

            text_parts.append(text)

        elif item_type == "hardBreak":
            text_parts.append("\n")

        elif item_type == "mention":
            # @username
            text_parts.append(f"@{item.get('attrs', {}).get('text', 'user')}")

        elif item_type == "inlineCard":
            # Link
            url = item.get("attrs", {}).get("url", "")
            text_parts.append(url)

    return "".join(text_parts)


def _extract_code_block_text(node: Dict[str, Any]) -> str:
    """Extract text from a code block node."""
    content = node.get("content", [])
    lines = []

    for item in content:
        if item.get("type") == "text":
            lines.append(item.get("text", ""))

    return "\n".join(lines)


def _extract_list_text(node: Dict[str, Any], ordered: bool = False) -> str:
    """Extract text from a list node."""
    content = node.get("content", [])
    lines = []

    for idx, item in enumerate(content):
        if item.get("type") == "listItem":
            item_content = item.get("content", [])
            item_text = ""

            for sub_node in item_content:
                if sub_node.get("type") == "paragraph":
                    item_text += _extract_paragraph_text(sub_node)

            prefix = f"{idx + 1}." if ordered else "-"
            lines.append(f"{prefix} {item_text}")

    return "\n".join(lines)


def _extract_heading_text(node: Dict[str, Any]) -> str:
    """Extract text from a heading node."""
    level = node.get("attrs", {}).get("level", 1)
    content = node.get("content", [])

    text_parts = []
    for item in content:
        if item.get("type") == "text":
            text_parts.append(item.get("text", ""))

    heading_text = "".join(text_parts)
    prefix = "#" * level
    return f"{prefix} {heading_text}"


def is_adf_format(value: Any) -> bool:
    """Check if a value is already in ADF format.

    Args:
        value: Value to check

    Returns:
        True if value is ADF format, False otherwise
    """
    if not isinstance(value, dict):
        return False

    return (
        value.get("type") == "doc" and
        value.get("version") == 1 and
        isinstance(value.get("content"), list)
    )


def ensure_adf_format(value: Union[str, Dict[str, Any]]) -> Dict[str, Any]:
    """Ensure a value is in ADF format, converting if necessary.

    Args:
        value: String or ADF dict

    Returns:
        ADF document structure
    """
    if isinstance(value, str):
        return text_to_adf(value)
    elif is_adf_format(value):
        return value
    else:
        logger.warning(f"Unknown format for ADF conversion: {type(value)}, treating as empty")
        return text_to_adf("")


def create_empty_adf() -> Dict[str, Any]:
    """Create an empty ADF document.

    Returns:
        Empty ADF document structure
    """
    return {
        "version": 1,
        "type": "doc",
        "content": []
    }
