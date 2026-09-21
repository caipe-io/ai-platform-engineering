# Copyright 2025 CAIPE Contributors
# SPDX-License-Identifier: Apache-2.0
"""
Slack Block Kit formatting utilities for streaming task progress.

Builds task_update and plan_update chunks for chat.appendStream,
and error/text blocks for chat.stopStream / chat.postMessage.
"""

from typing import List, Dict, Any, Optional


# Maps backend statuses to Slack task_update statuses.
# Backend uses "completed"; Slack's task_update uses "complete".
STATUS_TO_SLACK = {
  "pending": "pending",
  "in_progress": "in_progress",
  "completed": "complete",
  "failed": "error",
}


def build_single_task_update(
  step_id: str,
  title: str,
  status: str,
  details: Optional[str] = None,
  output: Optional[str] = None,
) -> Dict[str, Any]:
  """Build a single task_update chunk for appendStream.

  Args:
      step_id: Unique ID for the task card.
      title: Display title.
      status: One of pending, in_progress, completed, failed.
      details: Optional short text shown below the title (max 256 chars).
      output: Optional output text shown on completion (max 256 chars).
  """
  chunk: Dict[str, Any] = {
    "type": "task_update",
    "id": step_id,
    "title": title[:250],
    "status": STATUS_TO_SLACK.get(status, "pending"),
  }
  if details:
    chunk["details"] = details[:250]
  if output:
    chunk["output"] = output[:250]
  return chunk


def build_plan_update(title: str) -> Dict[str, Any]:
  """Build a plan_update chunk for appendStream."""
  return {
    "type": "plan_update",
    "title": title[:250],
  }


def build_todo_task_updates(
  todos: List[Dict[str, Any]],
) -> List[Dict[str, Any]]:
  """Convert backend todo items to Slack task_update chunks.

  Args:
      todos: List of todo dicts with 'id', 'content', 'status'.
  """
  chunks = []
  for todo in todos:
    todo_id = todo.get("id", 0)
    chunk = build_single_task_update(
      step_id=f"todo_{todo_id}",
      title=todo.get("content", ""),
      status=todo.get("status", "pending"),
    )
    chunks.append(chunk)
  return chunks


def split_text_into_blocks(text: str, max_length: int = 3000) -> List[str]:
  """Split text into chunks that fit within Slack's block text limit."""
  if len(text) <= max_length:
    return [text]

  chunks = []
  current_chunk = ""

  paragraphs = text.split("\n\n")

  for paragraph in paragraphs:
    if len(paragraph) > max_length:
      if current_chunk:
        chunks.append(current_chunk.strip())
        current_chunk = ""

      lines = paragraph.split("\n")
      for line in lines:
        if len(line) > max_length:
          if current_chunk:
            chunks.append(current_chunk.strip())
          chunks.append(line[: max_length - 50] + "\n\n_[Line truncated due to length]_")
          current_chunk = ""
        elif len(current_chunk) + len(line) + 1 > max_length:
          chunks.append(current_chunk.strip())
          current_chunk = line
        else:
          current_chunk += ("\n" + line) if current_chunk else line

    elif len(current_chunk) + len(paragraph) + 2 > max_length:
      if current_chunk:
        chunks.append(current_chunk.strip())
      current_chunk = paragraph
    else:
      current_chunk += ("\n\n" + paragraph) if current_chunk else paragraph

  if current_chunk:
    chunks.append(current_chunk.strip())

  return chunks


SLACK_MAX_BLOCKS = 50

_TRUNCATION_BLOCK: Dict[str, Any] = {
  "type": "context",
  "elements": [
    {
      "type": "mrkdwn",
      "text": "_Response truncated — exceeded Slack's 50-block limit._",
    }
  ],
}


def enforce_block_limit(
  content_blocks: List[Dict[str, Any]],
  footer_blocks: List[Dict[str, Any]],
  max_blocks: int = SLACK_MAX_BLOCKS,
) -> List[Dict[str, Any]]:
  """Enforce Slack's block limit by truncating content blocks if necessary.

  Keeps all footer_blocks intact. If the total exceeds max_blocks, content
  is truncated and a notice block is inserted before the footer.

  Args:
      content_blocks: Main body blocks (markdown text, sections, etc.).
      footer_blocks: Trailing blocks (feedback, attribution) — never truncated.
      max_blocks: Slack's hard limit (default 50).
  """
  total = len(content_blocks) + len(footer_blocks)
  if total <= max_blocks:
    return content_blocks + footer_blocks

  # Reserve space for footer + 1 truncation notice
  max_content = max_blocks - len(footer_blocks) - 1
  if max_content < 1:
    max_content = 1

  return content_blocks[:max_content] + [_TRUNCATION_BLOCK] + footer_blocks


def format_error_message(error_message: str) -> List[Dict[str, Any]]:
  """Format an error message as Slack blocks."""
  return [
    {
      "type": "section",
      "text": {
        "type": "mrkdwn",
        "text": f"*Error*\n{error_message}",
      },
    },
    {
      "type": "context",
      "elements": [
        {
          "type": "mrkdwn",
          "text": "_You can try asking again or rephrase your question._",
        }
      ],
    },
  ]
