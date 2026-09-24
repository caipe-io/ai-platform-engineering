"""Single source for LLM construction, imported directly by consumers.

Deliberately re-exports nothing. ``providers`` and ``bedrock_family`` have no
third-party imports, so a consumer that needs only those two -- a sandboxed
harness worker, for example -- must be able to import them without LangChain
installed. An eager re-export of ``build`` here would make that impossible.

Import the submodule you need::

    from ai_platform_engineering.llm_wrapper.bedrock_family import resolve_bedrock_client
    from ai_platform_engineering.llm_wrapper.build import build_chat_model  # needs langchain

This directory declares no dependencies of its own; each consuming package pins
the provider integrations it ships. See README.md.
"""
