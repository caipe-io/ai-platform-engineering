"""Canonical LLM construction source, vendored by consumers rather than installed.

Deliberately re-exports nothing. ``providers`` and ``bedrock_family`` have no
third-party imports, so a consumer that vendors only those two -- a sandboxed
harness worker, for example -- must be able to import them without LangChain
installed. An eager re-export of ``build`` here would make that impossible.

Import the submodule you need::

    from llm_wrapper.bedrock_family import resolve_bedrock_client
    from llm_wrapper.build import build_chat_model  # needs langchain

See README.md for why this is copied rather than packaged.
"""
