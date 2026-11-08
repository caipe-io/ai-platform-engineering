"""Additional trusted runtime tools scoped to the admitted execution context."""
from contextvars import ContextVar
from typing import Any

# The native HTTP runtime leaves this empty. Harness Engine sets and resets it
# around graph construction/execution; its runtime cache key isolates the tools.
current_turn_tools: ContextVar[list[Any] | None] = ContextVar("current_turn_tools", default=None)
