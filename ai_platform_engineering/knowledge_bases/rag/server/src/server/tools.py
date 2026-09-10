import asyncio
import os
import re
from typing import Callable, Optional, List, Dict, Any

from common.utils import get_logger
from common.graph_db.base import GraphDB
from common.metadata_storage import MetadataStorage
from common.models.rbac import UserContext
import dotenv
from langchain_core.messages.utils import count_tokens_approximately
from redis.asyncio import Redis
from common.constants import KV_ONTOLOGY_VERSION_ID_KEY, PROP_DELIMITER, ONTOLOGY_VERSION_ID_KEY, PRIMARY_ID_KEY
from common.models.rag import valid_metadata_keys, MCPToolConfig, MCPBuiltinToolsConfig, ParallelSearch, StructuredEntity, StructuredEntityId
import traceback
from server.query_service import VectorDBQueryService
from server.rbac import (
  authorize_mcp_tool_call,
  authorize_search,
  get_accessible_datasource_ids,
  get_datasource_ids_for_collection,
  is_unsafe_rbac_bypass_enabled,
)
from server.doc_acl import merge_acl_filter
from fastmcp import FastMCP
from common.utils import json_encode
from server.snippet_utils import format_search_result

# Load environment variables from .env file
dotenv.load_dotenv(verbose=True)
logger = get_logger(__name__)

max_graph_raw_query_results = int(os.getenv("MAX_GRAPH_RAW_QUERY_RESULTS", 100))
max_graph_raw_query_tokens = int(os.getenv("MAX_GRAPH_RAW_QUERY_TOKENS", 80000))
search_result_truncate_length = int(os.getenv("SEARCH_RESULT_TRUNCATE_LENGTH", 500))

BUILTIN_MCP_TOOL_IDS = {
  "search",
  "fetch_document",
  "list_datasources_and_entity_types",
  "graph_explore_ontology_entity",
  "graph_explore_data_entity",
  "graph_fetch_data_entity_details",
  "graph_shortest_path_between_entity_types",
  "graph_raw_query_data",
  "graph_raw_query_ontology",
}


class AgentTools:
  def __init__(self, redis_client: Redis, vector_db_query_service: VectorDBQueryService, metadata_storage: MetadataStorage, data_graph_db: Optional[GraphDB] = None, ontology_graph_db: Optional[GraphDB] = None):
    self.redis_client = redis_client
    self.vector_db_query_service: VectorDBQueryService = vector_db_query_service
    self.metadata_storage: MetadataStorage = metadata_storage
    self.data_graphdb: Optional[GraphDB] = data_graph_db
    self.ontology_graphdb: Optional[GraphDB] = ontology_graph_db

  @staticmethod
  def _get_mcp_user_context() -> Optional[UserContext]:
    """Read the UserContext set by MCPAuthMiddleware via contextvars."""
    try:
      from server.restapi import mcp_user_context_var
      return mcp_user_context_var.get(None)
    except Exception:
      return None

  async def _resolve_accessible_datasource_ids(
    self,
    scope: str = "read",
  ) -> Optional[List[str]]:
    """
    Resolve accessible datasource IDs for the current MCP request user.

    Returns None when the user has unrestricted access (so the caller should
    skip filtering).  Returns a list of datasource IDs when filtering is
    required; an empty list means nothing is accessible.

    Fails CLOSED: no MCP user context means `MCPAuthMiddleware` never ran for
    this request (e.g. `MCP_AUTH_ENABLED=false`), so there is nothing to
    authorize against — deny rather than fall through to unrestricted access.
    The only unrestricted path is the explicit emergency bypass.
    """
    user = self._get_mcp_user_context()
    if user is None:
      return [] if not is_unsafe_rbac_bypass_enabled() else None
    accessible = await get_accessible_datasource_ids(user, scope)
    if "*" in accessible:
      return None
    return accessible

  # Tool IDs permanently managed by the server — never register from custom config
  _SKIP_TOOL_IDS = BUILTIN_MCP_TOOL_IDS

  async def _authorize_search_tool(
    self,
    tool_id: Optional[str] = None,
  ) -> tuple[Optional[UserContext], Optional[List[str]]]:
    """Apply feature, custom-tool, and datasource gates for a live MCP call."""
    user = self._get_mcp_user_context()
    if user is not None:
      await authorize_search(user)
      if tool_id is not None and tool_id not in BUILTIN_MCP_TOOL_IDS:
        await authorize_mcp_tool_call(user, tool_id)
    accessible = await self._resolve_accessible_datasource_ids("read")
    return user, accessible

  @staticmethod
  def _graph_entity_datasource_id(entity: StructuredEntity) -> Optional[str]:
    value = entity.all_properties.get("_datasource_id")
    return value if isinstance(value, str) and value else None

  @classmethod
  def _graph_entity_is_accessible(
    cls,
    entity: StructuredEntity,
    accessible: Optional[List[str]],
  ) -> bool:
    if accessible is None:
      return True
    datasource_id = cls._graph_entity_datasource_id(entity)
    # Untagged data-graph entities have no trustworthy provenance. Restricted
    # callers must never receive them.
    return datasource_id is not None and datasource_id in set(accessible)

  async def _filter_data_graph_relations(
    self,
    relations: List[Any],
    accessible: Optional[List[str]],
  ) -> List[Any]:
    """Keep only relations whose two endpoints have readable provenance."""
    if accessible is None:
      return relations
    if self.data_graphdb is None or not relations:
      return []

    endpoint_ids = {
      (endpoint.entity_type, endpoint.primary_key)
      for relation in relations
      for endpoint in (relation.from_entity, relation.to_entity)
    }
    allowed: set[tuple[str, str]] = set()
    for entity_type, primary_key in endpoint_ids:
      entity = await self.data_graphdb.fetch_entity(entity_type, primary_key)
      if entity is not None and self._graph_entity_is_accessible(entity, accessible):
        allowed.add((entity_type, primary_key))
    return [
      relation
      for relation in relations
      if (relation.from_entity.entity_type, relation.from_entity.primary_key) in allowed
      and (relation.to_entity.entity_type, relation.to_entity.primary_key) in allowed
    ]

  @staticmethod
  def _normalize_datasource_constraint(value: Any) -> Optional[List[str]]:
    """Normalize one optional datasource filter; invalid shapes deny all."""
    if value is None:
      return None
    if isinstance(value, str):
      return [value] if value else []
    if isinstance(value, (list, tuple, set)):
      result: List[str] = []
      seen: set[str] = set()
      for item in value:
        if not isinstance(item, str) or not item or item in seen:
          continue
        seen.add(item)
        result.append(item)
      return result
    return []

  @classmethod
  def _intersect_datasource_constraints(cls, *values: Any) -> Optional[List[str]]:
    """Intersect every present datasource constraint, preserving first order."""
    result: Optional[List[str]] = None
    for value in values:
      current = cls._normalize_datasource_constraint(value)
      if current is None:
        continue
      if result is None:
        result = current
      else:
        allowed = set(current)
        result = [item for item in result if item in allowed]
    return result

  # Default configuration for the built-in search tool
  _DEFAULT_SEARCH_CONFIG = MCPToolConfig(
    tool_id="search",
    description="Search for relevant documents in the knowledge base.",
    parallel_searches=[
      ParallelSearch(label="semantic_results", semantic_weight=0.7),
      ParallelSearch(label="keyword_results", semantic_weight=0.2),
    ],
    allow_runtime_filters=True,
    enabled=True,
  )

  async def register_tools(
    self,
    mcp: FastMCP,
    graph_rag_enabled: bool,
    builtin_config: MCPBuiltinToolsConfig,
    tool_configs: List[MCPToolConfig],
  ) -> None:
    """Register all MCP tools based on runtime configuration."""
    # Register the built-in search tool using the default config (if enabled)
    if builtin_config.search_enabled:
      fn = self._make_search_fn(self._DEFAULT_SEARCH_CONFIG, graph_rag_enabled)
      description = self._build_search_description(self._DEFAULT_SEARCH_CONFIG, graph_rag_enabled)
      mcp.tool(name_or_fn=fn, description=description)

    # Register each enabled custom search tool (skip reserved/built-in names)
    for config in tool_configs:
      if not config.enabled or config.tool_id in self._SKIP_TOOL_IDS:
        continue
      fn = self._make_search_fn(config, graph_rag_enabled)
      description = self._build_search_description(config, graph_rag_enabled)
      mcp.tool(name_or_fn=fn, description=description)

    # Built-in non-search tools
    if builtin_config.fetch_document_enabled:
      mcp.tool(self.fetch_document)
    if builtin_config.fetch_datasources_enabled:
      mcp.tool(self.list_datasources_and_entity_types)

    if graph_rag_enabled:
      graph_tools = [
        (builtin_config.graph_explore_ontology_entity_enabled, self.graph_explore_ontology_entity),
        (builtin_config.graph_explore_data_entity_enabled, self.graph_explore_data_entity),
        (builtin_config.graph_fetch_data_entity_details_enabled, self.graph_fetch_data_entity_details),
        (builtin_config.graph_shortest_path_between_entity_types_enabled, self.graph_shortest_path_between_entity_types),
        (builtin_config.graph_raw_query_data_enabled, self.graph_raw_query_data),
        (builtin_config.graph_raw_query_ontology_enabled, self.graph_raw_query_ontology),
      ]
      for enabled, tool in graph_tools:
        if enabled:
          mcp.tool(tool)

    logger.info(f"Registered MCP tools: {[t.name for t in await mcp.list_tools()]}")

  async def reload_tools(
    self,
    mcp: FastMCP,
    graph_rag_enabled: bool,
    builtin_config: MCPBuiltinToolsConfig,
    tool_configs: List[MCPToolConfig],
  ) -> None:
    """Hot-reload all MCP tools from updated configuration."""
    for tool_name in [t.name for t in await mcp.list_tools()]:
      mcp.remove_tool(tool_name)
    await self.register_tools(mcp, graph_rag_enabled, builtin_config, tool_configs)

  def _build_search_description(self, config: MCPToolConfig, graph_rag_enabled: bool) -> str:
    """Build the human/LLM-facing description for a search tool."""
    valid_filter_keys = valid_metadata_keys()
    has_structured_entity_search = any(ps.extra_filters.get("is_structured_entity") in (True, "true", "True") for ps in config.parallel_searches)
    if not (graph_rag_enabled and has_structured_entity_search):
      valid_filter_keys = [k for k in valid_filter_keys if "structured_entity" not in k]
    # collection_id is not stored document metadata (chunks only carry
    # datasource_id) — it is resolved to member datasource ids at query time,
    # so it is documented here rather than added to valid_metadata_keys().
    valid_filter_keys = valid_filter_keys + ["collection_id"]

    # Add note about nested metadata filters
    filters_line = f"    filters (dict): Optional metadata filters. Valid keys: {valid_filter_keys}. Also supports nested metadata filters like metadata.custom_field.\n" if config.allow_runtime_filters else ""

    labels = [ps.label for ps in config.parallel_searches]
    keys_str = ", ".join(f'"{lbl}"' for lbl in labels)
    return_section = f"Returns:\n    dict with keys: {keys_str}\n    Each key maps to a list of results with text_content (highlighted snippet), metadata, and score."

    base = config.description or "Search for relevant documents in the knowledge base."
    return (
      f"{base}\n\nArgs:\n    query (str): The search query. Use full sentences for best results (e.g., 'What is the deployment process?')\n{filters_line}    limit (int): Maximum number of results to return (default: 10).\n    thought (str): Your reasoning for choosing this tool.\n\n{return_section}"
    )

  def _make_search_fn(self, config: MCPToolConfig, graph_rag_enabled: bool) -> Callable:
    """
    Factory that returns a coroutine with the correct signature for the given config.
    FastMCP reads the function signature via inspect to build the JSON schema exposed to
    the LLM, so the outer wrapper must explicitly include or exclude the `filters` param.
    Both variants delegate to the shared `_execute` closure.
    """
    tool_id = config.tool_id
    parallel_searches: List[ParallelSearch] = list(config.parallel_searches)

    async def _execute(
      query: str,
      runtime_filters: Optional[Dict[str, Any]],
      limit: int,
      thought: str,
    ) -> Any:
      logger.info(f"[{tool_id}] query={query!r}, limit={limit}, runtime_filters={runtime_filters}, thought={thought!r}")

      # Explicit org-level search capability, mirroring the REST `/v1/query`
      # and debug `/v1/mcp/invoke` paths — the live FastMCP `/mcp` transport
      # has no other gate in front of this call.
      user, accessible = await self._authorize_search_tool(tool_id)

      # None means unrestricted (org admin / emergency bypass); a list is the
      # caller's accessible datasource ids, intersected below with any
      # request- or config-narrowed `datasource_id` filter — never widened.
      if accessible is not None and not accessible:
        return {ps.label: [] for ps in parallel_searches}

      async def _run_one(ps: ParallelSearch) -> List[Dict[str, Any]]:
        weights = [ps.semantic_weight, 1.0 - ps.semantic_weight]  # hybrid search
        q_filters: Dict[str, Any] = {}
        if runtime_filters:
          q_filters.update(runtime_filters)
        runtime_datasources = q_filters.pop("datasource_id", None)
        runtime_collections = self._normalize_datasource_constraint(q_filters.pop("collection_id", None))
        collection_datasources: Optional[List[str]] = None
        if runtime_collections is not None:
          resolved: set[str] = set()
          for collection_id in runtime_collections:
            resolved.update(await get_datasource_ids_for_collection(collection_id))
          collection_datasources = list(resolved)
        q_filters.update(ps.extra_filters)
        extra_datasources = q_filters.pop("datasource_id", None)
        configured_datasources = list(ps.datasource_ids) if ps.datasource_ids else None
        datasource_scope = self._intersect_datasource_constraints(
          runtime_datasources,
          collection_datasources,
          extra_datasources,
          configured_datasources,
          accessible,
        )
        if datasource_scope is not None:
          if not datasource_scope:
            return []
          q_filters["datasource_id"] = datasource_scope

        if user is not None:
          q_filters = merge_acl_filter(q_filters, user)

        results = await self.vector_db_query_service.query(
          query=query,
          filters=q_filters or None,
          limit=limit,
          ranker="weighted",
          ranker_params={"weights": weights},
        )
        output = []
        for result in results:
          text = format_search_result(
            page_content=result.document.page_content,
            metadata=result.document.metadata,
            query=query,
            max_total_length=search_result_truncate_length,
          )
          if len(result.document.page_content) > search_result_truncate_length:
            doc_id = result.document.metadata.get("document_id", "")
            if doc_id:
              text += f"\n\n[Content truncated. Use fetch_document with document_id='{doc_id}' to get full content if needed.]"
          output.append(
            {
              "text_content": text,
              "metadata": result.document.metadata,
              "score": result.score,
            }
          )
        return output

      # Run all parallel searches concurrently, always return dict keyed by label
      results_list = await asyncio.gather(
        *[_run_one(ps) for ps in parallel_searches],
        return_exceptions=True,
      )
      response: Dict[str, Any] = {}
      for ps, result in zip(parallel_searches, results_list):
        if isinstance(result, Exception):
          logger.error(f"[{tool_id}] parallel search '{ps.label}' failed: {result}\n{traceback.format_exc()}")
          response[ps.label] = []
        else:
          logger.info(f"[{tool_id}] parallel search '{ps.label}': {len(result)} results")
          response[ps.label] = result
      return response

    if config.allow_runtime_filters:

      async def _tool_with_filters(
        query: str,
        filters: Optional[dict] = None,
        limit: int = 10,
        thought: str = "",
      ) -> Any:
        return await _execute(query, filters, limit, thought)

      _tool_with_filters.__name__ = tool_id
      return _tool_with_filters
    else:

      async def _tool_no_filters(
        query: str,
        limit: int = 10,
        thought: str = "",
      ) -> Any:
        return await _execute(query, None, limit, thought)

      _tool_no_filters.__name__ = tool_id
      return _tool_no_filters

  async def fetch_document(self, document_id: str, filters: Optional[Dict[str, Any]] = None, thought: str = ""):
    """
    Fetch the full content of a document by its document_id (obtained from search results).

    Args:
        document_id (str): The document ID from search results
        filters (dict): Optional. Set by the runtime, not the caller, to narrow results
            to specific datasource_id(s) (e.g. {"datasource_id": ["ds-a"]}).
        thought (str): Your thoughts for choosing this tool

    Returns:
        dict: document with full content and metadata
    """
    logger.info(f"Fetching document with ID: {document_id}, Thought: {thought}")

    try:
      user, accessible = await self._authorize_search_tool()
      if accessible is not None and not accessible:
        return f"Error: Document with ID '{document_id}' not found in the knowledge base."

      q_filters: Dict[str, Any] = {"document_id": document_id}
      # Agent-config narrowing (client-pinned `filters["datasource_id"]`),
      # intersected with the caller's RBAC-accessible set — narrows, never widens.
      requested = filters.get("datasource_id") if filters else None
      datasource_scope = self._intersect_datasource_constraints(requested, accessible)
      if datasource_scope is not None:
        if not datasource_scope:
          return f"Error: Document with ID '{document_id}' not found in the knowledge base."
        q_filters["datasource_id"] = datasource_scope

      if user is not None:
        q_filters = merge_acl_filter(q_filters, user)

      # Query vector DB for the specific document
      results = await self.vector_db_query_service.query(
        query="",  # Empty query, we're filtering by ID
        filters=q_filters,
        limit=100,
        ranker="weighted",
        ranker_params={"weights": [1.0, 0.0]},
      )

      if not results:
        return f"Error: Document with ID '{document_id}' not found in the knowledge base."

      return results
    except Exception as e:
      logger.error(f"Traceback: {traceback.format_exc()}")
      logger.error(f"Error fetching document {document_id}: {e}")
      return f"Error fetching document '{document_id}': {str(e)}"

  async def list_datasources_and_entity_types(self, filters: Optional[Dict[str, Any]] = None, thought: str = ""):
    """
    Fetch list of available datasources and entity types in the knowledge base.

    Args:
        filters (dict): Optional. Set by the runtime, not the caller, to narrow results
            to specific datasource_id(s) (e.g. {"datasource_id": ["ds-a"]}).
        thought (str): Your thoughts for choosing this tool

    Returns:
        dict: list of datasources (from metadata storage) and entity types (from graph DB if available)
    """
    logger.info(f"Fetching datasources and entity types, Thought: {thought}")

    result = {"datasources": [], "entity_types": []}

    try:
      _user, accessible = await self._authorize_search_tool()

      # Get datasources from metadata storage
      datasources_info = await self.metadata_storage.fetch_all_datasource_info()
      ids = [ds.datasource_id for ds in datasources_info]
      if accessible is not None:
        ids = [i for i in ids if i in accessible]

      # Agent-config narrowing (client-pinned `filters["datasource_id"]`),
      # intersected with the caller's RBAC-accessible set — narrows, never widens.
      requested = filters.get("datasource_id") if filters else None
      datasource_scope = self._intersect_datasource_constraints(requested, accessible)
      if datasource_scope is not None:
        ids = [i for i in ids if i in set(datasource_scope)]

      result["datasources"] = ids

      # Ontology nodes are global schema and do not carry datasource
      # provenance. Returning them for a restricted or agent-pinned request
      # would therefore leak types from sources outside the effective scope.
      # Derive types from the provenance-tagged data graph in that case. Only
      # an unrestricted request may retain the existing global ontology view.
      if datasource_scope is not None:
        if self.data_graphdb is not None:
          entity_types = await self.data_graphdb.get_all_entity_types(
            datasource_ids=ids,
          )
          result["entity_types"] = sorted(list(entity_types))
        else:
          logger.info(
            "Data graph database not available; scoped entity_types will be empty"
          )
      elif self.ontology_graphdb is not None:
        entity_types = await self.ontology_graphdb.get_all_entity_types()
        result["entity_types"] = sorted(list(entity_types))
      else:
        logger.info("Graph database not available, entity_types will be empty")

      return result
    except Exception as e:
      logger.error(f"Traceback: {traceback.format_exc()}")
      logger.error(f"Error fetching datasources and entity types: {e}")
      return f"Error fetching datasources and entity types: {str(e)}"

  #####################
  # Graph query tools #
  #####################

  async def graph_explore_ontology_entity(
    self,
    entity_type: str,
    depth: int = 1,
    thought: str = "",
    filters: Optional[Dict[str, Any]] = None,
  ):
    """
    Explores an ontology entity and its neighborhood up to specified depth.
    Returns the root entity with full details and connected entities with essential properties only.

    Args:
        entity_type (str): The type of entity to explore
        depth (int): How many hops to explore (default: 1, max: 3)
        thought (str): Your thoughts for choosing this tool
        filters (dict): Runtime datasource pin. The global ontology cannot be
            filtered safely, so any bounded scope is denied.

    Returns:
        dict: containing the root entity (full details), connected entities (essential properties), and their relations
    """
    logger.info(f"Exploring ontology entity {entity_type} with depth {depth}, Thought: {thought}")
    _user, accessible = await self._authorize_search_tool()
    requested = filters.get("datasource_id") if filters else None
    datasource_scope = self._intersect_datasource_constraints(requested, accessible)
    if datasource_scope is not None:
      return "Error: Ontology graph access requires unrestricted datasource access."
    if self.ontology_graphdb is None:
      logger.error("Ontology graph database is not available, Is graph RAG enabled?")
      return "Error: Ontology graph database is not available. Please ensure graph RAG is enabled."

    # Validate and cap depth
    if depth < 1:
      depth = 1
    elif depth > 3:
      logger.warning(f"Depth {depth} exceeds maximum of 3, capping to 3")
      depth = 3

    try:
      # Check if ontology is generated
      is_ontology_generated = await self._graph_check_if_ontology_generated()
      if not is_ontology_generated:
        return "Error: The ontology has not been generated yet. Please generate the ontology first before exploring ontology entities."

      # Fetch the latest ontology id
      ontology_version_id = await self.redis_client.get(KV_ONTOLOGY_VERSION_ID_KEY)
      if ontology_version_id is None:
        return "Error: Ontology version ID not found in Redis. The ontology may not be generated yet."

      # Build primary key for ontology entity
      primary_key_id = PROP_DELIMITER.join([entity_type, ontology_version_id])

      # First check if the entity type exists in ontology
      all_entity_types = await self.ontology_graphdb.get_all_entity_types()
      if entity_type not in all_entity_types:
        return f"Error: StructuredEntity type '{entity_type}' does not exist in the ontology graph database.\nAvailable entity types: {', '.join(sorted(all_entity_types))}"

      # Explore the entity neighborhood with specified depth
      result = await self._explore_entity_with_depth(graphdb=self.ontology_graphdb, entity_type=entity_type, entity_pk=primary_key_id, max_depth=depth)

      if result["root_entity"] is None:
        return f"Error: StructuredEntity of type '{entity_type}' with primary key '{primary_key_id}' was not found in the ontology graph database. The entity may not exist or may have been deleted."

      # Check the size of the results, if too large return an error message instead
      result_str = json_encode(result)
      tokens = count_tokens_approximately(result_str)
      if tokens > max_graph_raw_query_tokens:
        logger.warning(f"Ontology entity exploration result is too large ({tokens} tokens), returning error message instead.")
        return (
          f"StructuredEntity exploration result is too large ({tokens} tokens, max: {max_graph_raw_query_tokens}). "
          "Please reduce the amount of data returned:\n"
          "- Use a smaller depth value (current: {depth})\n"
          "- Use graph_fetch_data_entity_details for a single entity without neighbors\n"
          "- Consider using graph_raw_query_ontology with LIMIT and specific property selection\n\n"
          f"StructuredEntity explored: {entity_type}"
        )

      return result
    except Exception as e:
      logger.error(f"Traceback: {traceback.format_exc()}")
      logger.error(f"Error exploring ontology entity {entity_type}: {e}")
      return f"Error exploring ontology entity '{entity_type}': {str(e)}\nTraceback: {traceback.format_exc()}"

  async def graph_explore_data_entity(
    self,
    entity_type: str,
    primary_key_id: str,
    depth: int = 1,
    thought: str = "",
    filters: Optional[Dict[str, Any]] = None,
  ):
    """
    Explores a data entity and its neighborhood up to specified depth.
    Returns the root entity with full details and connected entities with essential properties only.

    Args:
        entity_type (str): The type of entity to explore
        primary_key_id (str): The primary key id of the entity
        depth (int): How many hops to explore (default: 1, max: 3)
        thought (str): Your thoughts for choosing this tool
        filters (dict): Optional runtime datasource pin.

    Returns:
        dict: containing the root entity (full details), connected entities (essential properties), and their relations
    """
    logger.info(f"Exploring data entity {entity_type} with primary_key_id {primary_key_id} and depth {depth}, Thought: {thought}")
    _user, accessible = await self._authorize_search_tool()
    requested = filters.get("datasource_id") if filters else None
    datasource_scope = self._intersect_datasource_constraints(requested, accessible)
    if datasource_scope is not None and not datasource_scope:
      return "Error: You do not have access to any data graph sources."
    if self.data_graphdb is None:
      logger.error("Data graph database is not available, Is graph RAG enabled?")
      return "Error: Data graph database is not available. Please ensure graph RAG is enabled."

    # Validate and cap depth
    if depth < 1:
      depth = 1
    elif depth > 3:
      logger.warning(f"Depth {depth} exceeds maximum of 3, capping to 3")
      depth = 3

    try:
      # First check if the entity type exists
      all_entity_types = await self.data_graphdb.get_all_entity_types(
        datasource_ids=datasource_scope,
      )
      if entity_type not in all_entity_types:
        return f"Error: StructuredEntity type '{entity_type}' does not exist in the data graph database.\nAvailable entity types: {', '.join(sorted(all_entity_types))}"

      # Explore the entity neighborhood with specified depth
      result = await self._explore_entity_with_depth(
        graphdb=self.data_graphdb,
        entity_type=entity_type,
        entity_pk=primary_key_id,
        max_depth=depth,
        accessible=datasource_scope,
        enforce_datasource_acl=True,
      )

      if result["root_entity"] is None:
        return f"Error: StructuredEntity of type '{entity_type}' with primary key '{primary_key_id}' was not found in the data graph database. Please verify the entity type and primary key are correct."

      # Check the size of the results, if too large return an error message instead
      result_str = json_encode(result)
      tokens = count_tokens_approximately(result_str)
      if tokens > max_graph_raw_query_tokens:
        logger.warning(f"Data entity exploration result is too large ({tokens} tokens), returning error message instead.")
        return (
          f"StructuredEntity exploration result is too large ({tokens} tokens, max: {max_graph_raw_query_tokens}). "
          "Please reduce the amount of data returned:\n"
          "- Use a smaller depth value (current: {depth})\n"
          "- Use graph_fetch_data_entity_details for a single entity without neighbors\n"
          "- Consider using graph_raw_query_data with LIMIT and specific property selection\n\n"
          f"StructuredEntity explored: {entity_type} with primary_key_id: {primary_key_id}"
        )

      return result
    except Exception as e:
      logger.error(f"Traceback: {traceback.format_exc()}")
      logger.error(f"Error exploring data entity {entity_type} with primary_key_id {primary_key_id}: {e}")
      return f"Error exploring data entity '{entity_type}' with primary_key_id '{primary_key_id}': {str(e)}\nTraceback: {traceback.format_exc()}"

  async def _explore_entity_with_depth(
    self,
    graphdb: GraphDB,
    entity_type: str,
    entity_pk: str,
    max_depth: int,
    accessible: Optional[List[str]] = None,
    enforce_datasource_acl: bool = False,
  ) -> dict:
    """
    Explores an entity and its neighborhood up to specified depth.
    Returns root entity with full details, other entities with essential properties only.

    Args:
        graphdb: The graph database to query
        entity_type: Type of the root entity
        entity_pk: Primary key of the root entity
        max_depth: Maximum depth to explore (1-3)

    Returns:
        dict with keys:
            - root_entity: dict with full entity details
            - entities: list of connected entities with essential properties
            - relations: list of relation tuples (from_pk, relation_name, to_pk)
    """
    # Fetch the neighborhood from graph DB with specified depth
    neighborhood = await graphdb.explore_neighborhood(entity_type=entity_type, entity_pk=entity_pk, depth=max_depth, max_results=1000)

    if neighborhood["entity"] is None:
      return {"root_entity": None, "entities": [], "relations": []}

    root_entity = neighborhood["entity"]
    if enforce_datasource_acl and not self._graph_entity_is_accessible(root_entity, accessible):
      return {"root_entity": None, "entities": [], "relations": []}

    # Extract full entity data for root
    def extract_full_entity_data(entity: StructuredEntity) -> dict:
      """Extract complete entity data with all properties"""
      primary_key_values = {}
      for prop in entity.primary_key_properties:
        if prop in entity.all_properties:
          primary_key_values[prop] = entity.all_properties[prop]

      additional_key_values = []
      if entity.additional_key_properties:
        for key_props in entity.additional_key_properties:
          key_dict = {}
          for prop in key_props:
            if prop in entity.all_properties:
              key_dict[prop] = entity.all_properties[prop]
          if key_dict:
            additional_key_values.append(key_dict)

      # Get all properties except internal ones (those starting with _), but keep _entity_pk
      properties = {}
      for key, value in entity.all_properties.items():
        if key == PRIMARY_ID_KEY:  # Keep _entity_pk
          properties[key] = value
        elif not key.startswith("_"):  # Exclude other internal properties
          properties[key] = value

      return {"entity_type": entity.entity_type, "primary_key_values": primary_key_values, "additional_key_values": additional_key_values, "properties": properties}

    # Extract essential entity data for connected entities
    def extract_essential_entity_data(entity: StructuredEntity) -> dict:
      """Extract only essential entity data (primary keys and entity type)"""
      primary_key_values = {}
      for prop in entity.primary_key_properties:
        if prop in entity.all_properties:
          primary_key_values[prop] = entity.all_properties[prop]

      additional_key_values = []
      if entity.additional_key_properties:
        for key_props in entity.additional_key_properties:
          key_dict = {}
          for prop in key_props:
            if prop in entity.all_properties:
              key_dict[prop] = entity.all_properties[prop]
          if key_dict:
            additional_key_values.append(key_dict)

      return {"entity_type": entity.entity_type, "_entity_pk": entity.all_properties.get(PRIMARY_ID_KEY, ""), "primary_key_values": primary_key_values, "additional_key_values": additional_key_values}

    # Process root entity with full details
    root_entity_data = extract_full_entity_data(root_entity)

    # Process all connected entities with essential properties only
    connected_entities = []
    all_relations = []

    visible_entities = [
      entity
      for entity in neighborhood["entities"]
      if not enforce_datasource_acl or self._graph_entity_is_accessible(entity, accessible)
    ]
    visible_keys = {
      (
        entity.entity_type,
        str(entity.all_properties.get(PRIMARY_ID_KEY) or entity.generate_primary_key()),
      )
      for entity in [root_entity, *visible_entities]
    }

    for entity in visible_entities:
      # Skip the root entity itself
      if entity.all_properties.get(PRIMARY_ID_KEY) == entity_pk:
        continue

      connected_entities.append(extract_essential_entity_data(entity))

    # Process all relations
    for relation in neighborhood["relations"]:
      if enforce_datasource_acl and (
        (relation.from_entity.entity_type, relation.from_entity.primary_key) not in visible_keys
        or (relation.to_entity.entity_type, relation.to_entity.primary_key) not in visible_keys
      ):
        continue
      relation_tuple = (relation.from_entity.primary_key, relation.relation_name, relation.to_entity.primary_key)
      all_relations.append(relation_tuple)

    return {"root_entity": root_entity_data, "entities": connected_entities, "relations": all_relations}

  async def graph_fetch_data_entity_details(
    self,
    entity_type: str,
    primary_key_id: str,
    thought: str,
    filters: Optional[Dict[str, Any]] = None,
  ):
    """
    Fetches details of a single data entity and returns all its properties (excluding internal properties),
    as well as relations from the graph database.

    Args:
        entity_type (str): The type of entity
        primary_key_id (str): The primary key id of the entity
        thought (str): Your thoughts for choosing this tool
        filters (dict): Optional runtime datasource pin.

    Returns:
        str: The properties of the entity (with key:value pairs), as well as its relations
    """
    logger.info(f"Fetching data entity details of type {entity_type} with primary_key_id {primary_key_id}, Thought: {thought}")
    _user, accessible = await self._authorize_search_tool()
    requested = filters.get("datasource_id") if filters else None
    datasource_scope = self._intersect_datasource_constraints(requested, accessible)
    if datasource_scope is not None and not datasource_scope:
      return "Error: You do not have access to any data graph sources."
    if self.data_graphdb is None:
      logger.error("Graph database is not available, Is graph RAG enabled?")
      return "Error: Data graph database is not available. Please ensure graph RAG is enabled."
    try:
      # First check if the entity type exists
      all_entity_types = await self.data_graphdb.get_all_entity_types(
        datasource_ids=datasource_scope,
      )
      if entity_type not in all_entity_types:
        return f"Error: StructuredEntity type '{entity_type}' does not exist in the data graph database.\nAvailable entity types: {', '.join(sorted(all_entity_types))}"

      entity = await self.data_graphdb.fetch_entity(entity_type, primary_key_id)
      if entity is None:
        return f"Error: StructuredEntity of type '{entity_type}' with primary key '{primary_key_id}' was not found in the data graph database. Please verify the entity type and primary key are correct."
      if not self._graph_entity_is_accessible(entity, datasource_scope):
        return f"Error: StructuredEntity of type '{entity_type}' with primary key '{primary_key_id}' was not found in the data graph database."

      # Remove internal properties (those starting with _)
      clean_properties = {}
      for key, value in entity.all_properties.items():
        if not key.startswith("_"):
          clean_properties[key] = value

      # Get primary key values
      primary_key_values = {}
      for prop in entity.primary_key_properties:
        if prop in entity.all_properties:
          primary_key_values[prop] = entity.all_properties[prop]

      # Get additional key values
      additional_key_values = []
      if entity.additional_key_properties:
        for key_props in entity.additional_key_properties:
          key_dict = {}
          for prop in key_props:
            if prop in entity.all_properties:
              key_dict[prop] = entity.all_properties[prop]
          if key_dict:
            additional_key_values.append(key_dict)

      # Get the relations of the entity
      relations = await self.data_graphdb.fetch_entity_relations(entity_type, primary_key_id)
      relations = await self._filter_data_graph_relations(relations, datasource_scope)

      # Format relations as simple dicts
      relations_data = []
      for rel in relations:
        relations_data.append({"from_entity_type": rel.from_entity.entity_type, "from_entity_pk": rel.from_entity.primary_key, "relation_name": rel.relation_name, "to_entity_type": rel.to_entity.entity_type, "to_entity_pk": rel.to_entity.primary_key, "relation_properties": rel.relation_properties})

      return {
        "entity_type": entity.entity_type,
        "_entity_pk": entity.all_properties.get(PRIMARY_ID_KEY, ""),
        "primary_key_values": primary_key_values,
        "additional_key_values": additional_key_values,
        "properties": clean_properties,
        "relations": relations_data,
      }
    except Exception as e:
      logger.error(f"Traceback: {traceback.format_exc()}")
      logger.error(f"Error fetching entity details {entity_type} with primary_key_id {primary_key_id}: {e}")
      return f"Error fetching data entity details for '{entity_type}' with primary_key_id '{primary_key_id}': {str(e)}\nTraceback: {traceback.format_exc()}"

  async def graph_shortest_path_between_entity_types(
    self,
    entity_type_1: str,
    entity_type_2: str,
    thought: str,
    filters: Optional[Dict[str, Any]] = None,
  ):
    """
    Find the shortest relationship paths between two entity types in the ontology graph.

    Args:
        entity_type_1 (str): The first entity type
        entity_type_2 (str): The second entity type
        thought (str): Your thoughts for choosing this tool
        filters (dict): Runtime datasource pin. The global ontology cannot be
            filtered safely, so any bounded scope is denied.

    Returns:
        str: A cypher-like notation of entities and their relations, "none" if there is no path
    """
    logger.info(f"Getting shortest path between {entity_type_1} and {entity_type_2}, Thought: {thought}")
    _user, accessible = await self._authorize_search_tool()
    requested = filters.get("datasource_id") if filters else None
    datasource_scope = self._intersect_datasource_constraints(requested, accessible)
    if datasource_scope is not None:
      return "Error: Ontology graph access requires unrestricted datasource access."
    if self.ontology_graphdb is None:
      logger.error("Ontology graph database is not available, Is graph RAG enabled?")
      return "Error: Ontology graph database is not available. Please ensure graph RAG is enabled."
    try:
      # Check if ontology is generated
      is_ontology_generated = await self._graph_check_if_ontology_generated()
      if not is_ontology_generated:
        return "Error: The ontology has not been generated yet. Please generate the ontology first before finding paths between entity types."

      # Fetch the latest ontology id
      ontology_version_id = await self.redis_client.get(KV_ONTOLOGY_VERSION_ID_KEY)
      if ontology_version_id is None:
        return "Error: Ontology version ID not found in Redis. The ontology may not be generated yet."

      # Check if both entity types exist in ontology
      all_entity_types = await self.ontology_graphdb.get_all_entity_types()
      if entity_type_1 not in all_entity_types:
        return f"Error: StructuredEntity type '{entity_type_1}' does not exist in the ontology graph database.\nAvailable entity types: {', '.join(sorted(all_entity_types))}"
      if entity_type_2 not in all_entity_types:
        return f"Error: StructuredEntity type '{entity_type_2}' does not exist in the ontology graph database.\nAvailable entity types: {', '.join(sorted(all_entity_types))}"

      entity_a_id = StructuredEntityId(entity_type=entity_type_1, primary_key=PROP_DELIMITER.join([entity_type_1, ontology_version_id]))
      entity_b_id = StructuredEntityId(entity_type=entity_type_2, primary_key=PROP_DELIMITER.join([entity_type_2, ontology_version_id]))

      paths = await self.ontology_graphdb.shortest_path(
        entity_a=entity_a_id,
        entity_b=entity_b_id,
        ignore_direction=True,
      )
      if not paths:
        return f"No path found between entity types '{entity_type_1}' and '{entity_type_2}' in the ontology graph. These entity types may not be connected."

      # Convert paths to cypher notation
      relation_paths = []
      for entities, relations in paths:
        cypher_path_parts = []

        # Iterate through entities and relations to build the path
        for i, entity in enumerate(entities):
          # Add entity type in parentheses
          cypher_path_parts.append(f"({entity.entity_type})")

          # Add relation in brackets (except for the last entity)
          if i < len(relations):
            relation = relations[i]

            # check if relation is applied
            if not (relation.relation_properties and relation.relation_properties.get("is_applied", True)):
              # discard the path if any relation is not applied
              cypher_path_parts = []
              break

            # check the direction of the relation
            if relation.from_entity.entity_type == entity.entity_type:
              cypher_path_parts.append(f"-[{relation.relation_name}]->")
            else:
              cypher_path_parts.append(f"<-[{relation.relation_name}]-")

        # Join all parts to create the cypher notation for this path
        if cypher_path_parts:
          cypher_path = "".join(cypher_path_parts)
          relation_paths.append(cypher_path)

      if not relation_paths:
        return f"No applied relationships found between entity types '{entity_type_1}' and '{entity_type_2}'. Paths exist but no relations are marked as applied."

      output = "Paths:\n"
      for i, path in enumerate(relation_paths):
        output += f"{i + 1}. {path}\n"
      logger.debug(f"Shortest paths: {output}")
      return output
    except Exception as e:
      logger.error(f"Traceback: {traceback.format_exc()}")
      logger.error(f"Error getting shortest path between {entity_type_1} and {entity_type_2}: {e}")
      return f"Error finding shortest path between entity types '{entity_type_1}' and '{entity_type_2}': {str(e)}\nTraceback: {traceback.format_exc()}"

  def _inject_tenant_label_in_query(self, query: str, tenant_label: str) -> str:
    """
    Injects tenant label into node patterns in a Cypher query using regex.

    Examples:
        MATCH (n:Person) -> MATCH (n:TenantLabel:Person)
        MATCH (n) -> MATCH (n:TenantLabel)
        MATCH (a:Movie)-[r]->(b:Person) -> MATCH (a:TenantLabel:Movie)-[r]->(b:TenantLabel:Person)
        CREATE (n:Test) -> CREATE (n:TenantLabel:Test)  [Would warn but inject anyway]

    Args:
        query: The Cypher query to modify
        tenant_label: The tenant label to inject

    Returns:
        The modified query with tenant labels injected
    """
    if not tenant_label:
      return query

    # Pattern to match node patterns like (variable:Label) or (variable:Label1:Label2) or (variable)
    # This pattern captures:
    # - Opening parenthesis
    # - Optional variable name
    # - Optional existing labels (including multiple labels)
    # - Closing parenthesis
    # But NOT relationship patterns like -[r:TYPE]->

    def replace_node_pattern(match):
      full_match = match.group(0)
      var_name = match.group(1) if match.group(1) else ""
      existing_labels = match.group(2) if match.group(2) else ""

      # If tenant label is already present, don't add it again
      if tenant_label in existing_labels:
        return full_match

      # Build the new pattern with tenant label first
      if existing_labels:
        # Has existing labels, prepend tenant label
        new_pattern = f"({var_name}:{tenant_label}{existing_labels})"
      else:
        # No existing labels, just add tenant label
        new_pattern = f"({var_name}:{tenant_label})" if var_name else f"(:{tenant_label})"

      return new_pattern

    # Regex pattern explanation:
    # \(               - Opening parenthesis
    # ([a-zA-Z_]\w*)   - Capture group 1: variable name (optional, letters/underscore followed by word chars)
    # ((?::[a-zA-Z_]\w*)*)  - Capture group 2: existing labels like :Label1:Label2 (optional)
    # \)               - Closing parenthesis
    # (?!-)            - Negative lookahead: not followed by - (to avoid matching relationships)

    # Match node patterns but not relationship patterns
    pattern = r"\(([a-zA-Z_]\w*)((?::[a-zA-Z_]\w*)*)\)(?!-)"

    modified_query = re.sub(pattern, replace_node_pattern, query)

    if modified_query != query:
      logger.debug(f"Injected tenant label '{tenant_label}' into query")
      logger.debug(f"Original: {query}")
      logger.debug(f"Modified: {modified_query}")

    return modified_query

  async def graph_raw_query_data(self, query: str, thought: str):
    """
    Executes a raw read-only query on the data graph database.

    Args:
        query (str): The raw Cypher query
        thought (str): Your thoughts for choosing this tool

    Returns:
        str: The result of the raw query
    """
    logger.info(f"Raw graph query: {query}, Thought: {thought}")
    _user, accessible = await self._authorize_search_tool()
    if accessible is not None:
      return "Error: Raw data-graph queries require unrestricted datasource access."
    if self.data_graphdb is None:
      logger.error("Graph database is not available, Is graph RAG enabled?")
      return "Error: graph database is not available."

    # Inject tenant label into the query
    tenant_label = getattr(self.data_graphdb, "tenant_label", None)
    if tenant_label:
      query = self._inject_tenant_label_in_query(query, tenant_label)

    try:
      res = await self.data_graphdb.raw_query(query, readonly=True, max_results=max_graph_raw_query_results)
      notifications = json_encode(res.get("notifications", []))
      results = json_encode(res.get("results", []))

      # Check for warnings/errors in notifications first
      if "warning" in notifications.lower() or "error" in notifications.lower():
        logger.warning(f"Query returned warnings/errors: {notifications}")
        return f"Query has warnings/errors, PLEASE FIX your query: {notifications}"

      # Check the size of the results, if too large return an error message instead
      tokens = count_tokens_approximately(results)
      if tokens > max_graph_raw_query_tokens:
        logger.warning(f"Raw query result is too large ({tokens} tokens), returning error message instead.")
        return (
          f"Raw query result is too large ({tokens} tokens, max: {max_graph_raw_query_tokens}). "
          "Please refine your query to return less data:\n"
          "- Add LIMIT clause to restrict number of results\n"
          "- Select specific properties instead of returning entire nodes\n"
          "- Use filters (WHERE clause) to narrow down results\n"
          "- Consider using other specialized tools instead\n\n"
          f"Query executed: {query}"
        )
      output = {"results": results, "notifications": notifications}
      logger.debug(f"Raw query output: {output}")
      return json_encode(output)
    except Exception as e:
      logger.error(f"Traceback: {traceback.format_exc()}")
      logger.error(f"Error executing raw graph query: {e}")
      return f"Error executing raw graph query, PLEASE FIX your query: {e}"

  async def graph_raw_query_ontology(
    self,
    query: str,
    thought: str,
    filters: Optional[Dict[str, Any]] = None,
  ):
    """
    Executes a raw read-only query on the ontology graph database.

    Args:
        query (str): The raw Cypher query
        thought (str): Your thoughts for choosing this tool
        filters (dict): Runtime datasource pin. The global ontology cannot be
            filtered safely, so any bounded scope is denied.

    Returns:
        str: The result of the raw query
    """
    logger.info(f"Raw ontology graph query: {query}, Thought: {thought}")
    _user, accessible = await self._authorize_search_tool()
    requested = filters.get("datasource_id") if filters else None
    datasource_scope = self._intersect_datasource_constraints(requested, accessible)
    if datasource_scope is not None:
      return "Error: Ontology graph access requires unrestricted datasource access."
    if self.ontology_graphdb is None:
      logger.error("Ontology graph database is not available, Is graph RAG enabled?")
      return "Error: ontology graph database is not available."

    # Inject tenant label into the query
    tenant_label = getattr(self.ontology_graphdb, "tenant_label", None)
    if tenant_label:
      query = self._inject_tenant_label_in_query(query, tenant_label)

    try:
      res = await self.ontology_graphdb.raw_query(query, readonly=True, max_results=max_graph_raw_query_results)
      notifications = json_encode(res.get("notifications", []))
      results = json_encode(res.get("results", []))

      # Check for warnings/errors in notifications first
      if "warning" in notifications.lower() or "error" in notifications.lower():
        logger.warning(f"Query returned warnings/errors: {notifications}")
        return f"Query has warnings/errors, PLEASE FIX your query: {notifications}"

      # Check the size of the results, if too large return an error message instead
      tokens = count_tokens_approximately(results)
      if tokens > max_graph_raw_query_tokens:
        logger.warning(f"Raw query result is too large ({tokens} tokens), returning error message instead.")
        return (
          f"Raw query result is too large ({tokens} tokens, max: {max_graph_raw_query_tokens}). "
          "Please refine your query to return less data:\n"
          "- Add LIMIT clause to restrict number of results\n"
          "- Select specific properties instead of returning entire nodes\n"
          "- Use filters (WHERE clause) to narrow down results\n"
          "- Consider using other specialized tools instead\n\n"
          f"Query executed: {query}"
        )
      output = {"results": results, "notifications": notifications}
      logger.debug(f"Raw query output: {output}")
      return json_encode(output)
    except Exception as e:
      logger.error(f"Traceback: {traceback.format_exc()}")
      logger.error(f"Error executing raw ontology graph query: {e}")
      return f"Error executing raw ontology graph query, PLEASE FIX your query: {e}"

  # Not a tool, but used internally
  async def _graph_check_if_ontology_generated(self) -> bool:
    """
    Checks if the ontology is generated for the graph database.
    Returns:
        bool: true if the ontology is generated, false otherwise
    """
    if self.ontology_graphdb is None:
      logger.error("Graph database is not available, Is graph RAG enabled?")
      return False
    ontology_version_id = await self.redis_client.get(KV_ONTOLOGY_VERSION_ID_KEY)
    if ontology_version_id is None:
      return False
    logger.info(f"Found ontology version id: {ontology_version_id}")

    # Check if the ontology is generated - there should be at least one relation with the ontology version id
    relation = await self.ontology_graphdb.find_relations(None, None, None, {ONTOLOGY_VERSION_ID_KEY: ontology_version_id}, 1)

    if len(relation) > 0:
      return True

    logger.warning(f"No relations found in ontology with the current heuristics version id: {ontology_version_id}")
    return False
