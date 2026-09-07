# Copyright 2025 CAIPE Contributors
# SPDX-License-Identifier: Apache-2.0
"""Tests for the AG-UI HITL handler."""

import json
from unittest.mock import Mock

from ai_platform_engineering.integrations.slack_bot.sse_client import SSEEvent, SSEEventType
from ai_platform_engineering.integrations.slack_bot.utils.hitl_handler import (
  parse_agui_interrupt,
  format_hitl_form_blocks,
  extract_form_response,
  format_form_submission_response,
  HITLForm,
  HITLCallbackHandler,
  FormField,
  FormAction,
)


class TestParseAguiInterrupt:
  """Tests for parsing AG-UI RUN_FINISHED interrupt events."""

  def test_basic_interrupt(self):
    event = SSEEvent(
      type=SSEEventType.RUN_FINISHED,
      outcome="interrupt",
      interrupt={
        "id": "int-123",
        "reason": "human_input",
        "payload": {
          "prompt": "Please confirm deployment",
          "fields": [],
          "agent": "deploy-agent",
        },
      },
    )
    form = parse_agui_interrupt(event, conversation_id="conv-1", agent_id="agent-1")
    assert form.form_id == "hitl_int-123"
    assert form.title == "Please confirm deployment"
    assert form.description == "Agent: deploy-agent"
    assert form.conversation_id == "conv-1"
    assert form.agent_id == "agent-1"
    assert form.metadata["interrupt_id"] == "int-123"
    assert form.metadata["reason"] == "human_input"

  def test_interrupt_with_text_field(self):
    event = SSEEvent(
      type=SSEEventType.RUN_FINISHED,
      outcome="interrupt",
      interrupt={
        "id": "int-1",
        "reason": "human_input",
        "payload": {
          "prompt": "Enter details",
          "fields": [
            {
              "field_name": "reason",
              "field_type": "text",
              "field_label": "Reason",
              "required": True,
            }
          ],
        },
      },
    )
    form = parse_agui_interrupt(event)
    assert len(form.fields) == 1
    assert form.fields[0].field_id == "reason"
    assert form.fields[0].field_type == "text"
    assert form.fields[0].label == "Reason"
    assert form.fields[0].required is True

  def test_interrupt_with_select_field(self):
    event = SSEEvent(
      type=SSEEventType.RUN_FINISHED,
      outcome="interrupt",
      interrupt={
        "id": "int-1",
        "reason": "human_input",
        "payload": {
          "prompt": "Choose environment",
          "fields": [
            {
              "field_name": "env",
              "field_type": "select",
              "field_label": "Environment",
              "field_values": ["staging", "production"],
            }
          ],
        },
      },
    )
    form = parse_agui_interrupt(event)
    assert len(form.fields) == 1
    assert form.fields[0].field_type == "select"
    assert len(form.fields[0].options) == 2
    assert form.fields[0].options[0] == {"label": "staging", "value": "staging"}

  def test_interrupt_maps_number_to_text(self):
    """Number, URL, email field types are mapped to text."""
    event = SSEEvent(
      type=SSEEventType.RUN_FINISHED,
      outcome="interrupt",
      interrupt={
        "id": "int-1",
        "reason": "human_input",
        "payload": {
          "prompt": "Enter count",
          "fields": [
            {"field_name": "count", "field_type": "number", "field_label": "Count"},
            {"field_name": "url", "field_type": "url", "field_label": "URL"},
            {"field_name": "email", "field_type": "email", "field_label": "Email"},
          ],
        },
      },
    )
    form = parse_agui_interrupt(event)
    assert all(f.field_type == "text" for f in form.fields)

  def test_default_approve_reject_actions(self):
    event = SSEEvent(
      type=SSEEventType.RUN_FINISHED,
      outcome="interrupt",
      interrupt={
        "id": "int-1",
        "reason": "human_input",
        "payload": {"prompt": "Confirm?"},
      },
    )
    form = parse_agui_interrupt(event)
    assert len(form.actions) == 2
    assert form.actions[0].action_id == "approve"
    assert form.actions[1].action_id == "reject"

  def test_missing_interrupt_graceful(self):
    """Handle event with no interrupt dict."""
    event = SSEEvent(type=SSEEventType.RUN_FINISHED, outcome="interrupt")
    form = parse_agui_interrupt(event)
    assert form.form_id == "hitl_unknown"
    assert form.title == "Action Required"


class TestFormatHitlFormBlocks:
  """Tests for rendering HITLForm as Slack Block Kit blocks."""

  def test_basic_form_structure(self):
    form = HITLForm(
      form_id="hitl_1",
      title="Confirm deployment",
      description="Agent: deploy-agent",
      conversation_id="conv-1",
      agent_id="agent-1",
      actions=[
        FormAction(action_id="approve", label="Approve", style="primary"),
        FormAction(action_id="reject", label="Reject", style="danger"),
      ],
    )
    blocks = format_hitl_form_blocks(form)
    # Should have: header, description section, divider, divider (before actions), actions, context
    assert blocks[0]["type"] == "header"
    assert blocks[0]["text"]["text"] == "Confirm deployment"
    # Find actions block
    action_blocks = [b for b in blocks if b.get("type") == "actions"]
    assert len(action_blocks) == 1
    elements = action_blocks[0]["elements"]
    assert len(elements) == 2

  def test_button_values_contain_context(self):
    """Button values must embed conversation_id, agent_id, and interrupt_id."""
    form = HITLForm(
      form_id="hitl_1",
      title="Test",
      conversation_id="conv-abc",
      agent_id="agent-xyz",
      metadata={"interrupt_id": "int-1"},
      actions=[FormAction(action_id="approve", label="Approve")],
    )
    blocks = format_hitl_form_blocks(form)
    action_block = next(b for b in blocks if b.get("type") == "actions")
    button = action_block["elements"][0]
    value = json.loads(button["value"])
    assert value["conversation_id"] == "conv-abc"
    assert value["agent_id"] == "agent-xyz"
    assert value["interrupt_id"] == "int-1"

  def test_text_field_rendered_as_input(self):
    form = HITLForm(
      form_id="hitl_1",
      title="Test",
      fields=[FormField(field_id="name", field_type="text", label="Name")],
      actions=[],
    )
    blocks = format_hitl_form_blocks(form)
    input_blocks = [b for b in blocks if b.get("type") == "input"]
    assert len(input_blocks) == 1
    assert input_blocks[0]["element"]["type"] == "plain_text_input"

  def test_select_field_rendered(self):
    form = HITLForm(
      form_id="hitl_1",
      title="Test",
      fields=[
        FormField(
          field_id="env",
          field_type="select",
          label="Environment",
          options=[
            {"label": "staging", "value": "staging"},
            {"label": "prod", "value": "prod"},
          ],
        )
      ],
      actions=[],
    )
    blocks = format_hitl_form_blocks(form)
    section_blocks = [b for b in blocks if b.get("type") == "section" and "accessory" in b]
    assert len(section_blocks) == 1
    assert section_blocks[0]["accessory"]["type"] == "static_select"


class TestExtractFormResponse:
  """Tests for extracting form field values from Slack payloads."""

  def test_text_input(self):
    payload = {"state": {"values": {"block_hitl_1_name": {"hitl_1_name": {"value": "John Doe"}}}}}
    response = extract_form_response(payload, "hitl_1")
    assert response["name"] == "John Doe"

  def test_select_input(self):
    payload = {"state": {"values": {"block_hitl_1_env": {"hitl_1_env": {"selected_option": {"value": "production"}}}}}}
    response = extract_form_response(payload, "hitl_1")
    assert response["env"] == "production"

  def test_multiselect_input(self):
    payload = {
      "state": {
        "values": {
          "block_hitl_1_tags": {
            "hitl_1_tags": {
              "selected_options": [
                {"value": "urgent"},
                {"value": "critical"},
              ]
            }
          }
        }
      }
    }
    response = extract_form_response(payload, "hitl_1")
    assert response["tags"] == ["urgent", "critical"]

  def test_select_none_selected(self):
    """Regression: selected_option is None when user hasn't picked anything."""
    payload = {"state": {"values": {"block_hitl_1_format": {"hitl_1_format": {"type": "static_select", "selected_option": None}}}}}
    response = extract_form_response(payload, "hitl_1")
    assert "format" not in response

  def test_multiselect_none_selected(self):
    """selected_options can be empty list or None."""
    payload = {"state": {"values": {"block_hitl_1_tags": {"hitl_1_tags": {"type": "multi_static_select", "selected_options": []}}}}}
    response = extract_form_response(payload, "hitl_1")
    assert "tags" not in response

  def test_mixed_fields_some_none(self):
    """Some fields filled, some left empty — only filled fields appear."""
    payload = {
      "state": {
        "values": {
          "block_hitl_1_name": {"hitl_1_name": {"value": "Alice"}},
          "block_hitl_1_env": {"hitl_1_env": {"type": "static_select", "selected_option": None}},
        }
      }
    }
    response = extract_form_response(payload, "hitl_1")
    assert response["name"] == "Alice"
    assert "env" not in response


class TestHITLCallbackHandler:
  """Tests for the HITL callback handler."""

  def test_handle_approve(self):
    handler = HITLCallbackHandler(sse_client=Mock())
    slack_client = Mock()
    slack_client.chat_update.return_value = {"ok": True}

    payload = {
      "actions": [
        {
          "action_id": "hitl_1_approve",
          "value": json.dumps(
            {
              "action": "approve",
              "form_id": "hitl_1",
              "conversation_id": "conv-1",
              "agent_id": "agent-1",
              "interrupt_id": "int-1",
            }
          ),
        }
      ],
      "state": {"values": {}},
      "channel": {"id": "C123"},
      "message": {"ts": "msg-ts-1", "thread_ts": "thread-ts-1"},
    }

    result = handler.handle_interaction(payload, slack_client)
    assert result is not None
    ctx = result["resume_context"]
    assert ctx["conversation_id"] == "conv-1"
    assert ctx["agent_id"] == "agent-1"
    assert ctx["channel_id"] == "C123"
    form_data = json.loads(ctx["form_data"])
    assert form_data["action"] == "approve"

  def test_handle_reject(self):
    handler = HITLCallbackHandler(sse_client=Mock())
    slack_client = Mock()
    slack_client.chat_update.return_value = {"ok": True}

    payload = {
      "actions": [
        {
          "action_id": "hitl_1_reject",
          "value": json.dumps(
            {
              "action": "reject",
              "form_id": "hitl_1",
              "conversation_id": "conv-1",
              "agent_id": "agent-1",
              "interrupt_id": "int-1",
            }
          ),
        }
      ],
      "state": {"values": {}},
      "channel": {"id": "C123"},
      "message": {"ts": "msg-ts-1", "thread_ts": "thread-ts-1"},
    }

    result = handler.handle_interaction(payload, slack_client)
    assert result is not None
    form_data = json.loads(result["resume_context"]["form_data"])
    assert form_data["action"] == "reject"
    assert "reason" in form_data

  def test_non_hitl_action_returns_none(self):
    handler = HITLCallbackHandler(sse_client=Mock())
    payload = {
      "actions": [{"action_id": "caipe_feedback", "value": "positive|ts"}],
    }
    result = handler.handle_interaction(payload, Mock())
    assert result is None

  def test_empty_actions_returns_none(self):
    handler = HITLCallbackHandler(sse_client=Mock())
    result = handler.handle_interaction({"actions": []}, Mock())
    assert result is None


class TestFormatFormSubmissionResponse:
  """Tests for form submission response formatting."""

  def test_success_format(self):
    blocks = format_form_submission_response(
      action="approve",
      form_values={"env": "production"},
      success=True,
    )
    assert any("submitted successfully" in b.get("text", {}).get("text", "") for b in blocks)

  def test_failure_format(self):
    blocks = format_form_submission_response(
      action="approve",
      form_values={},
      success=False,
    )
    assert any("submission failed" in b.get("text", {}).get("text", "") for b in blocks)
