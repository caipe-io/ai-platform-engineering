# Copyright 2025 CAIPE Contributors
# SPDX-License-Identifier: Apache-2.0
"""
Human-in-the-Loop (HITL) Handler

Handles AG-UI interrupt events with interactive Slack Block Kit elements:
- Text fields -> Slack plain_text_input
- Select fields -> Slack static_select
- Multiselect fields -> Slack multi_static_select
- Boolean fields -> Approve/Reject button pair
- Number/URL/Email fields -> Slack plain_text_input
- Approve/Reject buttons -> Slack button elements
- Form submission callbacks via Slack interactivity
"""

import json
import os
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

from loguru import logger

APP_NAME = os.environ.get("SLACK_INTEGRATION_APP_NAME", os.environ.get("APP_NAME", "CAIPE"))


@dataclass
class FormField:
  """Represents a form field"""

  field_id: str
  field_type: str  # text, select, multiselect, boolean, number, url, email, textarea
  label: str
  placeholder: Optional[str] = None
  options: Optional[List[Dict[str, str]]] = None
  required: bool = False
  default_value: Optional[str] = None


@dataclass
class FormAction:
  """Represents a form action button"""

  action_id: str
  label: str
  style: str = "primary"
  value: Optional[str] = None


@dataclass
class HITLForm:
  """Represents a complete HITL form"""

  form_id: str
  title: str
  description: str = ""
  fields: List[FormField] = field(default_factory=list)
  actions: List[FormAction] = field(default_factory=list)
  conversation_id: Optional[str] = None
  agent_id: Optional[str] = None
  metadata: Dict[str, Any] = field(default_factory=dict)


def parse_agui_interrupt(event, conversation_id: str = None, agent_id: str = None) -> HITLForm:
  """Parse an AG-UI RUN_FINISHED interrupt event into an HITLForm.

  Args:
      event: SSEEvent with type=RUN_FINISHED, outcome="interrupt".
      conversation_id: UUID v5 conversation ID for resuming.
      agent_id: Dynamic agent config ID for resuming.

  Returns:
      HITLForm ready to render as Slack blocks.
  """
  interrupt = event.interrupt or {}

  interrupt_id = interrupt.get("id", "unknown")
  reason = interrupt.get("reason", "human_input")
  payload = interrupt.get("payload", {})

  prompt = payload.get("prompt", "Action Required")
  raw_fields = payload.get("fields", [])
  agent = payload.get("agent", "")

  form = HITLForm(
    form_id=f"hitl_{interrupt_id}",
    title=prompt,
    description=f"Agent: {agent}" if agent else "",
    conversation_id=conversation_id,
    agent_id=agent_id,
    metadata={"interrupt_id": interrupt_id, "reason": reason},
  )

  for f in raw_fields:
    field_name = f.get("field_name", f.get("name", ""))
    field_type = f.get("field_type", f.get("type", "text"))
    field_label = f.get("field_label", f.get("label", field_name))

    # Map AG-UI field types to our internal types
    # boolean -> handled as two buttons at the form level, but stored as text
    # number, url, email -> plain_text_input
    if field_type in ("number", "url", "email"):
      mapped_type = "text"
    elif field_type == "boolean":
      mapped_type = "text"  # Rendered as text input; actual approval is via action buttons
    else:
      mapped_type = field_type  # text, select, multiselect, textarea

    # Build options for select/multiselect from field_values
    options = None
    raw_values = f.get("field_values", f.get("options"))
    if raw_values and isinstance(raw_values, list) and mapped_type in ("select", "multiselect"):
      options = []
      for val in raw_values:
        if isinstance(val, dict):
          options.append(val)
        else:
          options.append({"label": str(val), "value": str(val)})

    form_field = FormField(
      field_id=field_name,
      field_type=mapped_type,
      label=field_label,
      placeholder=f.get("placeholder"),
      options=options,
      required=f.get("required", False),
      default_value=f.get("default_value", f.get("default")),
    )
    form.fields.append(form_field)

  # Default approve/reject actions
  form.actions = [
    FormAction(action_id="approve", label="Approve", style="primary"),
    FormAction(action_id="reject", label="Reject", style="danger"),
  ]

  return form


def parse_form_data(form_data: Dict[str, Any], task_id: str = None, context_id: str = None) -> HITLForm:
  """Parse form data from legacy caipe_form artifact into HITLForm.

  Kept for backward compatibility during migration. New code should
  use parse_agui_interrupt() instead.
  """
  form = HITLForm(
    form_id=form_data.get("form_id", f"hitl_form_{task_id or 'unknown'}"),
    title=form_data.get("title", "Action Required"),
    description=form_data.get("description", ""),
    conversation_id=context_id,
    metadata=form_data.get("metadata", {}),
  )

  for field_data in form_data.get("fields", []):
    form_field = FormField(
      field_id=field_data.get("id", field_data.get("name", "")),
      field_type=field_data.get("type", "text"),
      label=field_data.get("label", field_data.get("name", "")),
      placeholder=field_data.get("placeholder"),
      options=field_data.get("options"),
      required=field_data.get("required", False),
      default_value=field_data.get("default"),
    )
    form.fields.append(form_field)

  for action_data in form_data.get("actions", []):
    action = FormAction(
      action_id=action_data.get("id", action_data.get("name", "")),
      label=action_data.get("label", action_data.get("name", "")),
      style=action_data.get("style", "primary"),
      value=action_data.get("value"),
    )
    form.actions.append(action)

  if not form.actions:
    form.actions = [
      FormAction(action_id="approve", label="Approve", style="primary"),
      FormAction(action_id="reject", label="Reject", style="danger"),
    ]

  return form


def format_hitl_form_blocks(form: HITLForm) -> List[Dict[str, Any]]:
  """Format a HITLForm as Slack Block Kit blocks.

  Embeds conversation_id and agent_id in button action values
  so the resume handler can extract them.
  """
  blocks = []

  blocks.append(
    {
      "type": "header",
      "text": {"type": "plain_text", "text": f"{form.title}", "emoji": True},
    }
  )

  if form.description:
    blocks.append(
      {
        "type": "section",
        "text": {"type": "mrkdwn", "text": form.description},
      }
    )

  blocks.append({"type": "divider"})

  for form_field in form.fields:
    field_block = _format_form_field(form_field, form.form_id)
    if field_block:
      blocks.append(field_block)

  if form.actions:
    action_elements = []
    for action in form.actions:
      button = {
        "type": "button",
        "text": {"type": "plain_text", "text": action.label, "emoji": True},
        "action_id": f"{form.form_id}_{action.action_id}",
        "value": json.dumps(
          {
            "action": action.action_id,
            "form_id": form.form_id,
            "conversation_id": form.conversation_id,
            "agent_id": form.agent_id,
            "interrupt_id": form.metadata.get("interrupt_id"),
          }
        ),
      }

      if action.style == "primary":
        button["style"] = "primary"
      elif action.style == "danger":
        button["style"] = "danger"

      action_elements.append(button)

    blocks.append({"type": "divider"})
    blocks.append({"type": "actions", "elements": action_elements})

  blocks.append(
    {
      "type": "context",
      "elements": [
        {
          "type": "mrkdwn",
          "text": f"_Please respond to continue \u2022 This form was generated by {APP_NAME}_",
        }
      ],
    }
  )

  return blocks


def _format_form_field(form_field: FormField, form_id: str) -> Optional[Dict[str, Any]]:
  """Format a single form field as a Slack block."""
  action_id = f"{form_id}_{form_field.field_id}"

  if form_field.field_type == "select":
    options = []
    for opt in form_field.options or []:
      options.append(
        {
          "text": {"type": "plain_text", "text": opt.get("label", opt.get("value", ""))},
          "value": opt.get("value", opt.get("label", "")),
        }
      )

    if not options:
      return None

    element = {
      "type": "static_select",
      "action_id": action_id,
      "placeholder": {
        "type": "plain_text",
        "text": form_field.placeholder or f"Select {form_field.label}",
      },
      "options": options,
    }

    if form_field.default_value:
      for opt in options:
        if opt["value"] == form_field.default_value:
          element["initial_option"] = opt
          break

    return {
      "type": "section",
      "text": {
        "type": "mrkdwn",
        "text": f"*{form_field.label}*" + (" _(required)_" if form_field.required else ""),
      },
      "accessory": element,
    }

  elif form_field.field_type == "multiselect":
    options = []
    for opt in form_field.options or []:
      options.append(
        {
          "text": {"type": "plain_text", "text": opt.get("label", opt.get("value", ""))},
          "value": opt.get("value", opt.get("label", "")),
        }
      )

    if not options:
      return None

    return {
      "type": "section",
      "text": {
        "type": "mrkdwn",
        "text": f"*{form_field.label}*" + (" _(required)_" if form_field.required else ""),
      },
      "accessory": {
        "type": "multi_static_select",
        "action_id": action_id,
        "placeholder": {
          "type": "plain_text",
          "text": form_field.placeholder or f"Select {form_field.label}",
        },
        "options": options,
      },
    }

  elif form_field.field_type in ("text", "number", "url", "email"):
    return {
      "type": "input",
      "block_id": f"block_{action_id}",
      "element": {
        "type": "plain_text_input",
        "action_id": action_id,
        "placeholder": {
          "type": "plain_text",
          "text": form_field.placeholder or f"Enter {form_field.label}",
        },
      },
      "label": {"type": "plain_text", "text": form_field.label},
      "optional": not form_field.required,
    }

  elif form_field.field_type == "textarea":
    return {
      "type": "input",
      "block_id": f"block_{action_id}",
      "element": {
        "type": "plain_text_input",
        "action_id": action_id,
        "multiline": True,
        "placeholder": {
          "type": "plain_text",
          "text": form_field.placeholder or f"Enter {form_field.label}",
        },
      },
      "label": {"type": "plain_text", "text": form_field.label},
      "optional": not form_field.required,
    }

  return None


def extract_form_response(payload: Dict[str, Any], form_id: str) -> Dict[str, Any]:
  """Extract form field values from a Slack interaction payload."""
  response = {}

  state = payload.get("state", {})
  values = state.get("values", {})

  for block_id, block_values in values.items():
    for action_id, action_value in block_values.items():
      if action_id.startswith(f"{form_id}_"):
        field_id = action_id[len(f"{form_id}_") :]

        if "value" in action_value:
          response[field_id] = action_value["value"]
        elif "selected_option" in action_value:
          opt = action_value["selected_option"]
          # selected_option is None when user hasn't picked anything yet
          if opt is not None:
            response[field_id] = opt["value"]
        elif "selected_options" in action_value:
          opts = action_value["selected_options"]
          if opts:
            response[field_id] = [opt["value"] for opt in opts]

  return response


def format_form_submission_response(
  action: str,
  form_values: Dict[str, Any],
  success: bool = True,
) -> List[Dict[str, Any]]:
  """Format a response message after form submission."""
  if success:
    icon = "\u2705"
    status = "submitted successfully"
  else:
    icon = "\u274c"
    status = "submission failed"

  blocks = [
    {"type": "section", "text": {"type": "mrkdwn", "text": f"{icon} Form {status}"}},
    {
      "type": "context",
      "elements": [{"type": "mrkdwn", "text": f"_Action: {action.title()}_"}],
    },
  ]

  if form_values:
    value_lines = []
    for field_id, value in form_values.items():
      if isinstance(value, list):
        value_str = ", ".join(value)
      else:
        value_str = str(value)
      value_lines.append(f"* *{field_id}*: {value_str}")

    if value_lines:
      blocks.append({"type": "section", "text": {"type": "mrkdwn", "text": "\n".join(value_lines)}})

  return blocks


class HITLCallbackHandler:
  """Handles HITL form callbacks and resumes agents via SSEClient."""

  def __init__(self, sse_client):
    self.sse_client = sse_client

  def handle_interaction(self, payload: Dict[str, Any], slack_client) -> Optional[Dict[str, Any]]:
    """Handle a Slack interaction payload for HITL forms.

    Extracts conversation_id and agent_id from the button value,
    collects form field values, and calls sse_client.resume_stream().

    Returns:
        dict with resume_context for the caller to process the resume
        stream, or None on error.
    """
    actions = payload.get("actions", [])
    if not actions:
      return None

    action = actions[0]
    action_id = action.get("action_id", "")

    if not action_id.startswith("hitl_"):
      return None

    try:
      value_data = json.loads(action.get("value", "{}"))
      form_id = value_data.get("form_id")
      action_name = value_data.get("action")
      conversation_id = value_data.get("conversation_id")
      agent_id = value_data.get("agent_id")
      interrupt_id = value_data.get("interrupt_id")

      form_values = extract_form_response(payload, form_id)

      logger.info(f"HITL form submission: form={form_id}, action={action_name}, conversation_id={conversation_id}, agent_id={agent_id}, interrupt_id={interrupt_id}, values={form_values}")

      channel_id = payload.get("channel", {}).get("id")
      message_ts = payload.get("message", {}).get("ts")

      # Update the form message to show submission status
      if channel_id and message_ts:
        response_blocks = format_form_submission_response(
          action=action_name,
          form_values=form_values,
          success=True,
        )
        slack_client.chat_update(
          channel=channel_id,
          ts=message_ts,
          blocks=response_blocks,
          text=f"Form {action_name}",
        )

      # Build form_data string for resume endpoint
      if action_name == "reject":
        form_data = json.dumps({"action": "reject", "reason": "User rejected"})
      else:
        form_data = json.dumps({"action": "approve", "values": form_values})

      # Return context for the caller (app.py) to process the resume stream
      return {
        "resume_context": {
          "conversation_id": conversation_id,
          "agent_id": agent_id,
          "form_data": form_data,
          "channel_id": channel_id,
          "thread_ts": payload.get("message", {}).get("thread_ts") or payload.get("container", {}).get("thread_ts"),
        }
      }

    except Exception as e:
      logger.exception(f"Error handling HITL interaction: {e}")
      return None
