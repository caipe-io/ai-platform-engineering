"""Tests for _render_system_prompt() Jinja2 rendering."""

import pytest

from dynamic_agents.models import ClientContext, UserContext
from dynamic_agents.services.agent_runtime import (
    SystemPromptRenderError,
    _jinja_env,
    _render_system_prompt,
)


class TestRenderSystemPrompt:
    """Tests for Jinja2 system prompt rendering with client context."""

    def test_plain_prompt_passes_through(self):
        """Plain text with no Jinja2 syntax is returned unchanged."""
        prompt = "You are a helpful assistant."
        result = _render_system_prompt(prompt, None)
        assert result == prompt

    def test_renders_source(self):
        """Template referencing client_context.source renders correctly."""
        prompt = "User is on {{ client_context.source }}."
        ctx = ClientContext(source="slack")
        result = _render_system_prompt(prompt, ctx)
        assert result == "User is on slack."

    def test_renders_extra_fields(self):
        """Extra fields on ClientContext are available in templates."""
        prompt = "Channel: {{ client_context.channel_name }}."
        ctx = ClientContext(source="slack", channel_name="#platform-eng")
        result = _render_system_prompt(prompt, ctx)
        assert result == "Channel: #platform-eng."

    def test_missing_key_returns_empty_string(self):
        """Accessing a missing key renders as empty string, no crash."""
        prompt = "Value: '{{ client_context.nonexistent }}'."
        ctx = ClientContext(source="slack")
        result = _render_system_prompt(prompt, ctx)
        assert result == "Value: ''."

    def test_missing_nested_key_no_crash(self):
        """Accessing nested missing keys doesn't crash (ChainableUndefined)."""
        prompt = "Value: '{{ client_context.foo.bar }}'."
        ctx = ClientContext(source="slack")
        result = _render_system_prompt(prompt, ctx)
        assert result == "Value: ''."

    def test_none_context_skips_conditionals(self):
        """When client_context is None, all {% if %} blocks are skipped."""
        prompt = "Base prompt.{% if client_context.overthink %} Overthink instructions.{% endif %}"
        result = _render_system_prompt(prompt, None)
        assert result == "Base prompt."

    def test_conditional_true(self):
        """{% if %} block renders when condition is truthy."""
        prompt = "Base.{% if client_context.overthink %} Check confidence.{% endif %}"
        ctx = ClientContext(source="slack", overthink=True)
        result = _render_system_prompt(prompt, ctx)
        assert result == "Base. Check confidence."

    def test_conditional_false(self):
        """{% if %} block is skipped when condition is falsy."""
        prompt = "Base.{% if client_context.overthink %} Check confidence.{% endif %}"
        ctx = ClientContext(source="slack", overthink=False)
        result = _render_system_prompt(prompt, ctx)
        assert result == "Base."

    def test_backward_compatible_no_jinja_syntax(self):
        """Existing prompts without any Jinja2 syntax work unchanged."""
        prompt = (
            "You are a platform engineering assistant.\n"
            "Help users with Kubernetes, CI/CD, and infrastructure questions.\n"
            "Be concise and accurate."
        )
        result = _render_system_prompt(prompt, None)
        assert result == prompt

    def test_source_equality_check(self):
        """Template can check source == 'slack' in conditionals."""
        prompt = "{% if client_context.source == 'slack' %}Keep it short.{% else %}Be detailed.{% endif %}"
        slack_ctx = ClientContext(source="slack")
        web_ctx = ClientContext(source="webui")

        assert _render_system_prompt(prompt, slack_ctx) == "Keep it short."
        assert _render_system_prompt(prompt, web_ctx) == "Be detailed."


class TestUserContextRendering:
    """Tests for user context in system prompt rendering."""

    def test_renders_user_email(self):
        """Template can reference user.email."""
        prompt = "Current user: {{ user.email }}."
        user = UserContext(email="alice@example.com")
        result = _render_system_prompt(prompt, None, user=user)
        assert result == "Current user: alice@example.com."

    def test_user_conditional(self):
        """Template can branch on user fields like is_admin."""
        prompt = "Base.{% if user.is_admin %} You have admin privileges.{% endif %}"
        admin = UserContext(email="admin@example.com", is_admin=True)
        regular = UserContext(email="user@example.com", is_admin=False)
        assert _render_system_prompt(prompt, None, user=admin) == "Base. You have admin privileges."
        assert _render_system_prompt(prompt, None, user=regular) == "Base."

    def test_none_user_skips_conditionals(self):
        """When user is None, all user conditionals are skipped."""
        prompt = "Base.{% if user.email %} Hello {{ user.email }}.{% endif %}"
        result = _render_system_prompt(prompt, None, user=None)
        assert result == "Base."


class TestSandboxSecurity:
    """Tests that the Jinja2 sandbox blocks unsafe operations."""

    def test_dunder_access_returns_empty(self):
        """Dunder attributes on real objects are blocked (render as empty)."""
        prompt = "{{ ''.__class__ }}"
        ctx = ClientContext(source="test")
        result = _render_system_prompt(prompt, ctx)
        assert result == ""

    def test_dunder_on_context_dict_returns_empty(self):
        """Dunder attributes on the context dict are blocked."""
        prompt = "{{ client_context.__class__ }}"
        ctx = ClientContext(source="test")
        result = _render_system_prompt(prompt, ctx)
        assert result == ""

    def test_globals_stripped(self):
        """Built-in globals (lipsum, range, cycler, etc.) are not available."""
        assert _jinja_env.globals == {}

    def test_lipsum_not_available(self):
        """lipsum() is not available — raises SystemPromptRenderError."""
        with pytest.raises(SystemPromptRenderError, match="lipsum"):
            _render_system_prompt("{{ lipsum() }}", None)

    def test_range_not_available(self):
        """range() is not available — raises SystemPromptRenderError."""
        with pytest.raises(SystemPromptRenderError, match="range"):
            _render_system_prompt("{% for i in range(10) %}{{ i }}{% endfor %}", None)

    def test_dict_not_available(self):
        """dict() is not available — raises SystemPromptRenderError."""
        with pytest.raises(SystemPromptRenderError, match="dict"):
            _render_system_prompt("{{ dict(a=1) }}", None)

    def test_context_mutation_is_blocked(self):
        """Templates cannot mutate list values supplied in render context."""
        user = UserContext(email="user@example.com", groups=["primary"])
        with pytest.raises(SystemPromptRenderError, match="unsafe"):
            _render_system_prompt("{{ user.groups.append('secondary') }}", None, user=user)

    @pytest.mark.parametrize(
        "expression",
        [
            "user.groups.append('secondary')",
            "user.groups.clear()",
            "user.groups.extend(['secondary'])",
            "user.groups.insert(0, 'secondary')",
            "user.groups.pop()",
            "user.groups.remove('primary')",
            "user.groups.reverse()",
            "user.groups.sort()",
            "client_context.labels.clear()",
            "client_context.labels.pop('primary')",
            "client_context.labels.popitem()",
            "client_context.labels.setdefault('secondary', 'value')",
            "client_context.labels.update({'secondary': 'value'})",
        ],
    )
    def test_known_list_and_mapping_mutators_are_blocked(self, expression: str) -> None:
        user = UserContext(email="user@example.com", groups=["primary"])
        ctx = ClientContext(source="test", labels={"primary": "value"})

        with pytest.raises(SystemPromptRenderError, match="unsafe"):
            _render_system_prompt(f"{{{{ {expression} }}}}", ctx, user=user)

        assert user.groups == ["primary"]
        assert ctx.model_dump()["labels"] == {"primary": "value"}

    def test_read_only_iteration_and_mapping_access_still_render(self) -> None:
        user = UserContext(email="user@example.com", groups=["primary", "secondary"])
        ctx = ClientContext(source="test", labels={"tier": "example"})

        result = _render_system_prompt(
            "{% for group in user.groups %}{{ group }};{% endfor %} {{ client_context.labels.tier }}",
            ctx,
            user=user,
        )

        assert result == "primary;secondary; example"


class TestTemplateErrorHandling:
    """Tests that template failures raise SystemPromptRenderError."""

    def test_syntax_error_raises(self):
        """Malformed template syntax raises SystemPromptRenderError."""
        with pytest.raises(SystemPromptRenderError, match="syntax"):
            _render_system_prompt("{{ unclosed", None)

    def test_unclosed_block_raises(self):
        """Unclosed block tag raises SystemPromptRenderError."""
        with pytest.raises(SystemPromptRenderError, match="syntax"):
            _render_system_prompt("{% if true %} no endif", None)

    def test_error_includes_original_message(self):
        """SystemPromptRenderError includes the original error detail."""
        with pytest.raises(SystemPromptRenderError) as exc_info:
            _render_system_prompt("{{ unclosed", None)
        assert "end of print statement" in str(exc_info.value)

    def test_error_chains_original_exception(self):
        """SystemPromptRenderError chains the original cause via __cause__."""
        with pytest.raises(SystemPromptRenderError) as exc_info:
            _render_system_prompt("{{ unclosed", None)
        assert exc_info.value.__cause__ is not None


class TestClientContextModel:
    """Tests for the ClientContext Pydantic model."""

    def test_source_required(self):
        """source field is required."""
        with pytest.raises(Exception):
            ClientContext()

    def test_extra_fields_allowed(self):
        """Extra fields are stored via extra='allow'."""
        ctx = ClientContext(source="slack", overthink=True, channel_type="channel")
        dumped = ctx.model_dump()
        assert dumped["source"] == "slack"
        assert dumped["overthink"] is True
        assert dumped["channel_type"] == "channel"

    def test_model_dump_includes_extras(self):
        """model_dump() includes extra fields for Jinja2 rendering."""
        ctx = ClientContext(source="slack", channel_name="#test", user_email="a@b.com")
        d = ctx.model_dump()
        assert d["channel_name"] == "#test"
        assert d["user_email"] == "a@b.com"
