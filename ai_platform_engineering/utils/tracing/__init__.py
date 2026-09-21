# Copyright 2025 CAIPE Contributors
# SPDX-License-Identifier: Apache-2.0

"""Tracing helpers for ai-platform-engineering.

Currently exposes one thing: ``install_skill_content_scrubber``, an
OpenTelemetry ``SpanProcessor`` that strips skill payloads (SKILL.md
bodies, ancillary file contents, the ``skills_metadata`` channel)
from every span before it leaves the process.

This is a **scoped redaction** — normal chat content, tool I/O for
non-skill tools, model names, latencies, token counts, and span
hierarchy are all preserved. We only redact what would otherwise
ferry every skill artifact to Langfuse on every step of every
multi-step skill run.

Usage::

    # Run AFTER cnoe_agent_utils.tracing.manager has set up the
    # global TracerProvider (so we can attach to the same provider).
    from ai_platform_engineering.utils.tracing import install_skill_content_scrubber
    install_skill_content_scrubber()
"""

from ai_platform_engineering.utils.tracing.skill_scrubber import (
    install_skill_content_scrubber,
    SkillContentScrubbingProcessor,
)

__all__ = [
    "install_skill_content_scrubber",
    "SkillContentScrubbingProcessor",
]
