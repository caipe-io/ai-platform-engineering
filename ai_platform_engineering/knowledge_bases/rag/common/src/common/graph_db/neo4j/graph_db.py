from __future__ import annotations

import json
import os
import time
from typing import Any, List, Optional, Tuple, Union

import neo4j
from neo4j import Record, AsyncGraphDatabase, GraphDatabase
from cymple.builder import QueryBuilder  # TODO: Move away from cymple, limited support for complex queries
from neo4j.graph import Node, Relationship
import asyncio

import common.utils as utils

from common.graph_db.base import GraphDB
from common.constants import ALL_IDS_KEY, ALL_IDS_PROPS_KEY, PRIMARY_ID_KEY, ENTITY_TYPE_KEY, PROP_DELIMITER, FRESH_UNTIL_KEY, RELATION_PK_KEY, DATASOURCE_ID_KEY

from common.models.rag import StructuredEntity, StructuredEntityId
from common.models.graph import Relation
from common.models.ontology import ValueMatchType

logger = utils.get_logger("neo4j_graph_db")


def sanitize_property_value(value: Any) -> Any:
  """
  Sanitize a property value for Neo4j compatibility.
  Neo4j only supports: str, int, float, bool, and lists of these types.
  This function converts unsupported types to compatible ones.

  Args:
      value: The value to sanitize

  Returns:
      A Neo4j-compatible value
  """
  # Handle None
  if value is None:
    return None

  # Handle basic supported types
  if isinstance(value, (str, bool)):
    return value

  # Handle numeric types - convert to standard Python types
  if isinstance(value, (int, float)):
    # Convert any special numeric types to standard Python int/float
    if isinstance(value, int):
      return int(value)
    else:
      return float(value)

  # Handle dictionaries - convert to JSON string
  if isinstance(value, dict):
    try:
      return json.dumps(value, default=str, sort_keys=True)
    except Exception:
      return str(value)

  # Handle lists - recursively sanitize elements
  if isinstance(value, (list, tuple)):
    if not value:
      return []

    # Sanitize all elements first
    sanitized_list = []
    for item in value:
      sanitized_item = sanitize_property_value(item)
      # Skip None values in lists (Neo4j doesn't support them well)
      if sanitized_item is not None:
        sanitized_list.append(sanitized_item)

    if not sanitized_list:
      return []

    # Check if the list is homogeneous (all same type)
    first_type = type(sanitized_list[0])
    is_homogeneous = all(type(item) is first_type for item in sanitized_list)

    # If not homogeneous, convert all elements to strings
    if not is_homogeneous:
      return [str(item) for item in sanitized_list]

    return sanitized_list

  # For any other type, convert to string
  return str(value)


def sanitize_entity_properties(properties: dict[str, Any]) -> dict[str, Any]:
  """
  Sanitize all properties in an entity dictionary for Neo4j compatibility.

  Args:
      properties: Dictionary of entity properties

  Returns:
      Dictionary with sanitized properties
  """
  sanitized = {}
  for key, value in properties.items():
    sanitized[key] = sanitize_property_value(value)
  return sanitized


class Neo4jDB(GraphDB):
  database_type: str = "neo4j"
  query_language: str = "cypher"

  def __init__(self, tenant_label: str, uri: str = "", username: str = "", password: str = "", readonly: bool = False, database: str = "neo4j"):
    logger.info("Initializing Neo4J Graph DB")

    # Tenant label is required for multi-tenancy support
    if not tenant_label:
      raise ValueError("tenant_label is required for Neo4j Graph DB instantiation")
    self.tenant_label = tenant_label

    if not uri:
      uri = os.getenv("NEO4J_ADDR", "bolt://localhost:7687")
    if not username:
      username = os.getenv("NEO4J_USERNAME", "neo4j")
    if not password:
      password = os.getenv("NEO4J_PASSWORD", "dummy_password")

    auth = (username, password)
    self.auth = auth
    self.uri = uri
    self.readonly = readonly
    self.database = database
    self.driver = AsyncGraphDatabase.driver(
      uri,
      auth=auth,
      notifications_min_severity="INFORMATION",
      connection_timeout=300,
      max_connection_lifetime=3600,
    )  # nosec
    self.non_async_driver = GraphDatabase.driver(
      uri,
      auth=auth,
      notifications_min_severity="INFORMATION",
      connection_timeout=300,
      max_connection_lifetime=3600,
    )  # nosec
    logger.info(f"Connecting to neo4j at {uri} with tenant label '{self.tenant_label}'")
    # Try to connect to the database, retry if it fails
    utils.retry_function(self.non_async_driver.verify_connectivity, 10, 10)
    logger.info(f"Connected to neo4j at {uri} with tenant label '{self.tenant_label}'")

  async def setup(self):
    logger.info(f"Setting up Neo4j Graph DB for tenant label '{self.tenant_label}'")

    logger.info("Setting up id indexes")
    await self._create_full_text_index(self.get_full_text_index_name(), [self.tenant_label], [ALL_IDS_KEY, ENTITY_TYPE_KEY], analyzer="standard")
    await self._create_full_text_index(self.get_full_text_strict_index_name(), [self.tenant_label], [ALL_IDS_KEY], analyzer="keyword")

    logger.info("Setting up fresh until index")
    await self._create_range_index(self.get_fresh_until_index_name(), [self.tenant_label], [FRESH_UNTIL_KEY])

    logger.info("Setting up entity type index")
    await self._create_range_index(self.get_entity_type_index_name(), [self.tenant_label], [ENTITY_TYPE_KEY])

    logger.info("Create unique constraint on entity type and primary key")
    await self._create_unique_constraint(self.tenant_label, [ENTITY_TYPE_KEY, PRIMARY_ID_KEY])

    # await self._create_unique_constraint_relation(["relation_id"]) # TODO

  async def status(self) -> bool:
    """
    Check the status of the graph database connection
    :return: True if the connection is healthy, False otherwise
    """
    try:
      async with self.driver.session(default_access_mode=neo4j.READ_ACCESS, database=self.database) as session:
        result = await session.run("RETURN 1 AS ok")  # type: ignore
        record = await result.single()
        if record and record["ok"] == 1:
          return True
        else:
          return False
    except Exception as e:
      logger.error(f"Neo4j connection check failed: {e}", exc_info=True)
      return False

  def get_tenant_label(self) -> str:
    return self.tenant_label

  def get_full_text_index_name(self) -> str:
    return f"{self.tenant_label}_id_fulltext"

  def get_full_text_strict_index_name(self) -> str:
    return f"{self.tenant_label}_id_fulltext_strict"

  def get_fresh_until_index_name(self) -> str:
    return f"{self.tenant_label}_freshuntil_range"

  def get_entity_type_index_name(self) -> str:
    return f"{self.tenant_label}_entitytype_range"

  async def fuzzy_search_batch(self, batch_keywords: List[List[List[Union[str, Tuple[float, str]]]]], exclude_type_filter: List[str] = [], num_record_per_type: int = 0, require_single_match_per_type: bool = False, strict: bool = True, max_results=100) -> List[List[Tuple[StructuredEntity, float]]]:
    """
    Fuzzy search properties in all entities (batched queries using UNWIND)
    Executes multiple fuzzy search queries in a SINGLE network call using UNWIND for maximum efficiency.

    Args:
        batch_keywords: List of keyword queries, where each query is a list of lists
                       E.g. batch_keywords = [
                           [['id1'], ['name1']],  # Query 1
                           [['id2'], ['name2']]   # Query 2
                       ]
        exclude_type_filter: List of entity types to exclude (shared across all queries)
        num_record_per_type: Number of records to return per type (0 = no limit)
        require_single_match_per_type: Only return results if exactly one match per type
        strict: Use keyword analyzer (True) vs standard analyzer (False)
        max_results: Maximum number of results to return per query

    Returns:
        List of results for each query, where each result is a List of (StructuredEntity, score) tuples
    """
    if not batch_keywords:
      return []

    logger.debug(f"Executing fuzzy_search_batch with {len(batch_keywords)} queries using UNWIND, exclude_type_filter={exclude_type_filter}, num_record_per_type={num_record_per_type}, require_single_match_per_type={require_single_match_per_type}, strict={strict}, max_results={max_results}")

    # Build query strings for each keyword batch
    query_data = []
    for idx, keywords in enumerate(batch_keywords):
      query_keywords = []
      # escape keywords for the query and AND/OR them together
      for kwlist in keywords:
        escaped_kwlist = []
        for kw in kwlist:
          if isinstance(kw, tuple):
            # Handle (weight, string) tuple
            weight, term = kw
            escaped_term = self._escape_keyword_lucene(str(term))
            # Apply boost using Lucene syntax: term^weight
            weighted_term = f"{escaped_term}^{weight}"
            escaped_kwlist.append(weighted_term)
          else:
            # Handle plain string
            escaped_term = self._escape_keyword_lucene(str(kw))
            escaped_kwlist.append(escaped_term)

        # escape query keywords for cypher
        escaped_kwlist = [f"{str(kw).replace("'", '\\"').replace('"', '\\"')}" for kw in escaped_kwlist]

        query_keywords.append(" OR ".join(escaped_kwlist))
      query_string = " AND ".join(f"({kwlist})" for kwlist in query_keywords)
      query_data.append({"idx": idx, "query": query_string})

    if strict:
      index_name = self.get_full_text_strict_index_name()
    else:
      index_name = self.get_full_text_index_name()

    # Build the batched query using UNWIND
    # We only filter by tenant label and exclude types
    tenant_filter = f"'{self.tenant_label}' IN labels(node)"

    exclude_filter_clause = ""
    if exclude_type_filter:
      exclude_type_filter_escaped = [self._escape_label(type) for type in exclude_type_filter]
      for exclude_type in exclude_type_filter_escaped:
        exclude_filter_clause += f" AND NOT '{exclude_type}' IN labels(node)"

    # Build the complete query with UNWIND
    # Use CALL (queryData) syntax to avoid Neo4j deprecation warning
    query = f"""
        UNWIND $queries AS queryData
        CALL (queryData) {{
            CALL db.index.fulltext.queryNodes('{index_name}', queryData.query) YIELD node, score
            WHERE {tenant_filter}{exclude_filter_clause}
            RETURN queryData.idx AS queryIdx, node, score
            ORDER BY score DESC
            LIMIT {max_results}
        }}
        RETURN queryIdx, node, score
        ORDER BY queryIdx, score DESC
        """

    logger.debug(f"Executing batched query with {len(query_data)} queries: {query}")

    async with self.driver.session(default_access_mode=neo4j.READ_ACCESS, database=self.database) as session:
      res = await session.run(query, queries=query_data)  # type: ignore
      records: list[Record] = await res.fetch(max_results * len(batch_keywords))

      # Group results by query index
      results_by_idx: dict[int, List[Tuple[StructuredEntity, float]]] = {i: [] for i in range(len(batch_keywords))}

      for record in records:
        query_idx: int = record.get("queryIdx")
        score: float = record.get("score")
        node: Node = record["node"]
        labels = set(node.labels)
        props = record.data()["node"]
        labels.discard(props[ENTITY_TYPE_KEY])
        labels.discard(self.tenant_label)

        # Create entity
        entity = StructuredEntity(entity_type=props[ENTITY_TYPE_KEY], primary_key_properties=props[ALL_IDS_PROPS_KEY][0].split(PROP_DELIMITER), additional_key_properties=[k.split(PROP_DELIMITER) for k in props[ALL_IDS_PROPS_KEY][1:]], additional_types=labels, all_properties=props)
        results_by_idx[query_idx].append((entity, score))

    # Return results in order
    return [results_by_idx[i] for i in range(len(batch_keywords))]

  async def get_all_entity_types(
    self,
    max_results: int = 1000,
    datasource_ids: List[str] | None = None,
  ) -> List[str]:
    """
    Gets all entity types in the database for this tenant.
    Returns distinct values from the _entity_type property.
    """
    logger.debug(f"Executing get_all_entity_types with max_results={max_results}")
    # Query to get distinct _entity_type values from nodes that have this tenant_label
    escaped_tenant_label = self._escape_label(self.tenant_label)
    conditions = [f"n.{ENTITY_TYPE_KEY} IS NOT NULL"]
    params: dict[str, Any] = {}
    if datasource_ids is not None:
      conditions.append(f"n.`{DATASOURCE_ID_KEY}` IN $datasource_ids")
      params["datasource_ids"] = datasource_ids
    query = (
      f"MATCH (n:{escaped_tenant_label}) "
      f"WHERE {' AND '.join(conditions)} "
      f"RETURN DISTINCT n.{ENTITY_TYPE_KEY} AS entity_type"
    )
    logger.debug(query)
    async with self.driver.session(default_access_mode=neo4j.READ_ACCESS, database=self.database) as session:
      res = await session.run(query, params)  # type: ignore
      records: list[Record] = await res.fetch(max_results)
      entity_types = []
      for record in records:
        entity_type = record.get("entity_type")
        if entity_type:
          entity_types.append(entity_type)

    return entity_types

  async def get_entity_count(self, entity_type: str | None = None) -> int:
    """
    Get the total count of entities in the graph database.

    Args:
        entity_type: Optional filter by entity type. If None, count all entities.

    Returns:
        int: Total number of entities
    """
    logger.debug(f"Executing get_entity_count with entity_type={entity_type}")

    escaped_tenant_label = self._escape_label(self.tenant_label)

    if entity_type:
      escaped_entity_type = self._escape_label(entity_type)
      query = f"""
            MATCH (n:{escaped_tenant_label}:{escaped_entity_type})
            WHERE n.`{ENTITY_TYPE_KEY}` <> '{escaped_tenant_label}'
            RETURN COUNT(n) AS count
            """
    else:
      query = f"""
            MATCH (n:{escaped_tenant_label})
            WHERE n.`{ENTITY_TYPE_KEY}` <> '{escaped_tenant_label}'
            RETURN COUNT(n) AS count
            """

    logger.debug(query)

    async with self.driver.session(default_access_mode=neo4j.READ_ACCESS, database=self.database) as session:
      res = await session.run(query)  # type: ignore
      record = await res.single()
      if record:
        return record.get("count", 0)
      return 0

  async def get_entity_type_properties(self, entity_type: str, max_results=1000) -> List[str]:
    """
    Get all properties for a given entity type in the graph database.

    Args:
        entity_type (str): The type of entity to get properties for
        max_results (int): Maximum number of results to return

    Returns:
        List[str]: A list of all properties for the specified entity type
    """
    logger.debug(f"Executing get_entity_type_properties with entity_type={entity_type}, max_results={max_results}")
    # Include tenant_label to ensure we only get properties from this tenant's entities
    escaped_tenant_label = self._escape_label(self.tenant_label)
    query = f"MATCH (n:{escaped_tenant_label}:{entity_type}) UNWIND keys(n) AS property RETURN DISTINCT property"
    logger.debug(query)
    async with self.driver.session(default_access_mode=neo4j.READ_ACCESS, database=self.database) as session:
      res = await session.run(query)  # type: ignore
      records: list[Record] = await res.fetch(max_results)
      properties = set()
      for record in records:
        if record.get("property"):
          prop_name = record["property"]
          # Filter out internal properties that start with underscore
          if not prop_name.startswith("_"):
            properties.add(prop_name)
    return list(properties)

  async def find_relations(self, from_entity_type: str | None = None, to_entity_type: str | None = None, relation_name: str | None = None, properties: dict | None = None, max_results: int = 10000) -> List[Relation]:
    """
    Finds relations between entities of specified types with given properties.

    Args:
        from_entity_type (str): The type of the source entity, empty for any
        to_entity_type (str): The type of the target entity, empty for any
        relation_name (str): The name of the relation, empty for any
        properties (dict): Properties to match on the relation
        max_results (int): Maximum number of results to return

    Returns:
        List[Relation]: List of matching relations
    """
    logger.debug(f"Executing find_relations with from_entity_type={from_entity_type}, to_entity_type={to_entity_type}, relation_name={relation_name}, properties={properties}, max_results={max_results}")
    # Build the match pattern - always include tenant_label
    if from_entity_type:
      from_pattern = f"(a:{self._escape_label(self.tenant_label)}:{self._escape_label(from_entity_type)})"
    else:
      from_pattern = f"(a:{self._escape_label(self.tenant_label)})"

    if to_entity_type:
      to_pattern = f"(b:{self._escape_label(self.tenant_label)}:{self._escape_label(to_entity_type)})"
    else:
      to_pattern = f"(b:{self._escape_label(self.tenant_label)})"

    rel_pattern = f"[r:{relation_name}]" if relation_name else "[r]"

    query_parts = [f"MATCH {from_pattern}-{rel_pattern}->{to_pattern}"]

    # Add WHERE clause for relation properties if provided
    where_conditions = []
    params = {}

    if properties:
      for key, value in properties.items():
        param_name = f"prop_{key}"
        where_conditions.append(f"r.`{key}` = ${param_name}")
        params[param_name] = value

    if where_conditions:
      query_parts.append("WHERE " + " AND ".join(where_conditions))

    query_parts.append("RETURN a, r, b")
    query_parts.append(f"LIMIT {max_results}")

    query = " ".join(query_parts)
    logger.debug(query)
    logger.debug(params)

    async with self.driver.session(default_access_mode=neo4j.READ_ACCESS, database=self.database) as session:
      res = await session.run(query, params)  # type: ignore
      records: list[Record] = await res.fetch(max_results)
      relations = []

      for record in records:
        from_node: Node = record["a"]
        rel: Relationship = record["r"]
        to_node: Node = record["b"]

        # Extract entity information
        from_entity_props = dict(from_node)
        to_entity_props = dict(to_node)

        # Get entity IDs and types
        from_entity_pk = from_entity_props.get(PRIMARY_ID_KEY, "")
        to_entity_pk = to_entity_props.get(PRIMARY_ID_KEY, "")

        from_entity_type = from_entity_props.get(ENTITY_TYPE_KEY, "")
        to_entity_type = to_entity_props.get(ENTITY_TYPE_KEY, "")

        relation_props = dict(rel.items())

        # Create Relation object
        relation = Relation(
          from_entity=StructuredEntityId(entity_type=str(from_entity_type), primary_key=str(from_entity_pk)),
          to_entity=StructuredEntityId(entity_type=str(to_entity_type), primary_key=str(to_entity_pk)),
          relation_name=rel.type,
          relation_pk=relation_props.get(RELATION_PK_KEY, ""),
          relation_properties=relation_props,
        )

        relations.append(relation)

      return relations

  async def fetch_relations_batch(
    self,
    offset: int = 0,
    limit: int = 10000,
    relation_name: str | None = None,
    datasource_ids: List[str] | None = None,
  ) -> List[Relation]:
    """
    Fetch relations in batches for efficient bulk processing.

    Args:
        offset: Number of relations to skip (for pagination)
        limit: Maximum number of relations to return
        relation_name: Optional filter by relation name

    Returns:
        List of relations in the batch
    """
    logger.debug(f"Fetching relations batch: offset={offset}, limit={limit}, relation_name={relation_name}")

    # Build query
    escaped_tenant_label = self._escape_label(self.tenant_label)

    from_pattern = f"(a:{escaped_tenant_label})"
    to_pattern = f"(b:{escaped_tenant_label})"

    if relation_name:
      escaped_relation_name = self._escape_label(relation_name)
      rel_pattern = f"[r:{escaped_relation_name}]"
    else:
      rel_pattern = "[r]"

    where_clause = ""
    params: dict[str, Any] = {}
    if datasource_ids is not None:
      where_clause = f"WHERE a.`{DATASOURCE_ID_KEY}` IN $datasource_ids AND b.`{DATASOURCE_ID_KEY}` IN $datasource_ids"
      params["datasource_ids"] = datasource_ids

    query = f"""
        MATCH {from_pattern}-{rel_pattern}->{to_pattern}
        {where_clause}
        RETURN a, r, b
        SKIP {offset}
        LIMIT {limit}
        """

    logger.debug(query)

    async with self.driver.session(default_access_mode=neo4j.READ_ACCESS, database=self.database) as session:
      res = await session.run(query, params)  # type: ignore
      records: list[Record] = await res.fetch(limit)
      relations = []

      for record in records:
        from_node: Node = record["a"]
        rel: Relationship = record["r"]
        to_node: Node = record["b"]

        # Extract entity information
        from_entity_props = dict(from_node)
        to_entity_props = dict(to_node)

        # Get entity IDs and types
        from_entity_pk = from_entity_props.get(PRIMARY_ID_KEY, "")
        to_entity_pk = to_entity_props.get(PRIMARY_ID_KEY, "")

        from_entity_type = from_entity_props.get(ENTITY_TYPE_KEY, "")
        to_entity_type = to_entity_props.get(ENTITY_TYPE_KEY, "")

        relation_props = dict(rel.items())

        # Create Relation object
        relation = Relation(
          from_entity=StructuredEntityId(entity_type=str(from_entity_type), primary_key=str(from_entity_pk)),
          to_entity=StructuredEntityId(entity_type=str(to_entity_type), primary_key=str(to_entity_pk)),
          relation_name=rel.type,
          relation_pk=relation_props.get(RELATION_PK_KEY, ""),
          relation_properties=relation_props,
        )

        relations.append(relation)

    logger.info(f"Fetched {len(relations)} relations in batch (offset={offset})")
    return relations

  async def fetch_entities_batch(
    self,
    offset: int = 0,
    limit: int = 10000,
    entity_type: str | None = None,
    datasource_ids: List[str] | None = None,
  ) -> List[StructuredEntity]:
    """
    Fetch entities in batches for efficient bulk processing.

    Args:
        offset: Number of entities to skip (for pagination)
        limit: Maximum number of entities to return
        entity_type: Optional filter by entity type

    Returns:
        List of entities in the batch
    """
    logger.debug(f"Fetching entities batch: offset={offset}, limit={limit}, entity_type={entity_type}")

    # Build query
    escaped_tenant_label = self._escape_label(self.tenant_label)

    if entity_type:
      escaped_entity_type = self._escape_label(entity_type)
      match_clause = f"MATCH (n:{escaped_tenant_label}:{escaped_entity_type})"
    else:
      match_clause = f"MATCH (n:{escaped_tenant_label})"

    where_conditions = [f"n.`{ENTITY_TYPE_KEY}` <> '{escaped_tenant_label}'"]
    params: dict[str, Any] = {}
    if datasource_ids is not None:
      where_conditions.append(f"n.`{DATASOURCE_ID_KEY}` IN $datasource_ids")
      params["datasource_ids"] = datasource_ids

    # Exclude default data label entities and apply authorization before
    # pagination so inaccessible rows cannot starve a page.
    query = f"""
        {match_clause}
        WHERE {" AND ".join(where_conditions)}
        RETURN n
        SKIP {offset}
        LIMIT {limit}
        """

    logger.debug(query)

    async with self.driver.session(default_access_mode=neo4j.READ_ACCESS, database=self.database) as session:
      res = await session.run(query, params)  # type: ignore
      records: list[Record] = await res.fetch(limit)
      entities = []

      for record in records:
        node: Node = record["n"]
        labels = set(node.labels)
        props = dict(node)
        labels.discard(props[ENTITY_TYPE_KEY])
        labels.discard(self.tenant_label)

        entity = StructuredEntity(entity_type=props[ENTITY_TYPE_KEY], primary_key_properties=props[ALL_IDS_PROPS_KEY][0].split(PROP_DELIMITER), additional_key_properties=[k.split(PROP_DELIMITER) for k in props[ALL_IDS_PROPS_KEY][1:]], additional_types=labels, all_properties=props)
        entities.append(entity)

    logger.info(f"Fetched {len(entities)} entities in batch (offset={offset})")
    return entities

  async def fetch_raw_entity_batch(self, labels: List[str], properties: List[str], offset: int, limit: int, exclude_labels: List[str] = []) -> List[dict]:
    """
    Fetch raw entity properties in batches without pydantic parsing.
    Returns simple dictionaries with only the requested properties.

    Args:
        labels: List of labels to match (e.g., ["NxsDataStructuredEntity"])
        properties: List of property names to return (e.g., ["_entity_pk", "_entity_type"])
        offset: Number of entities to skip (for pagination)
        limit: Maximum number of entities to return
        exclude_labels: List of labels to exclude from results (e.g., ["SomeLabel"])

    Returns:
        List of dictionaries with requested properties
    """
    logger.debug(f"Fetching raw entities batch: labels={labels}, properties={properties}, offset={offset}, limit={limit}, exclude_labels={exclude_labels}")

    # Build labels string - always include tenant_label
    all_labels = [self.tenant_label] + labels
    escaped_labels = [self._escape_label(label) for label in all_labels]
    labels_str = ":".join(escaped_labels)

    # Build RETURN clause with requested properties
    return_items = [f"n.`{prop}`" for prop in properties]
    return_clause = ", ".join(return_items)

    # Build WHERE clause for excluded labels
    where_clause = ""
    if exclude_labels:
      excluded_conditions = [f"NOT n:{self._escape_label(label)}" for label in exclude_labels]
      where_clause = "WHERE " + " AND ".join(excluded_conditions)

    # Build the query
    query = f"""
        MATCH (n:{labels_str})
        {where_clause}
        RETURN {return_clause}
        SKIP {offset}
        LIMIT {limit}
        """

    logger.debug(query)

    async with self.driver.session(default_access_mode=neo4j.READ_ACCESS, database=self.database) as session:
      res = await session.run(query)  # type: ignore
      records: list[Record] = await res.fetch(limit)

      # Convert records to list of dictionaries
      results = []
      for record in records:
        row_dict = {}
        for prop in properties:
          # Use the property name directly as the key in the result dictionary
          row_dict[prop] = record.get(f"n.`{prop}`")
        results.append(row_dict)

    logger.info(f"Fetched {len(results)} raw entities (offset={offset}, limit={limit}, excluded {len(exclude_labels)} labels)")
    return results

  async def find_entity(self, entity_type: str | None, properties: dict | None, max_results=10000) -> List[StructuredEntity]:
    logger.debug(f"Executing find_entity with entity_type={entity_type}, properties={properties}, max_results={max_results}")
    # Always include tenant_label in the query
    if entity_type is None or entity_type == "":
      labels = [self.tenant_label]
    else:
      labels = [self.tenant_label, entity_type]
    builder = (
      QueryBuilder().match().node(labels=labels, ref_name="e")  # type: ignore
    )

    if properties is not None and len(properties) > 0:
      props_with_ref = {f"e.`{key}`": value for key, value in properties.items()}
      builder = builder.where_multiple(props_with_ref, "=")  # type: ignore

    builder = builder.return_literal("e")
    builder = builder.limit(max_results)  # type: ignore

    query = str(builder)
    logger.debug(query)
    async with self.driver.session(default_access_mode=neo4j.READ_ACCESS, database=self.database) as session:
      res = await session.run(query)  # type: ignore
      records: list[Record] = await res.fetch(max_results)
      entities = []
      for record in records:
        node: Node = record["e"]
        labels = set(node.labels)
        props = record.data()["e"]
        labels.discard(props[ENTITY_TYPE_KEY])
        labels.discard(self.tenant_label)
        # Create a raw entity with labels, properties, and primary label
        entity = StructuredEntity(entity_type=props[ENTITY_TYPE_KEY], primary_key_properties=props[ALL_IDS_PROPS_KEY][0].split(PROP_DELIMITER), additional_key_properties=[k.split(PROP_DELIMITER) for k in props[ALL_IDS_PROPS_KEY][1:]], additional_types=labels, all_properties=props)

        entities.append(entity)
    return entities

  async def fetch_entity(self, entity_type: str, primary_key_value: str) -> StructuredEntity | None:
    logger.debug(f"Executing fetch_entity with entity_type={entity_type}, primary_key_value={primary_key_value}")
    entities = await self.find_entity(entity_type, {PRIMARY_ID_KEY: primary_key_value})
    if len(entities) == 0:
      return None
    else:
      return entities[0]

  async def fetch_entity_relations(self, entity_type: str, entity_pk: str, max_results: int = 10000) -> List[Relation]:
    logger.debug(f"Executing fetch_entity_relations with entity_type={entity_type}, entity_pk={entity_pk}, max_results={max_results}")
    # build the query - ensure both nodes have tenant_label
    qb = QueryBuilder()

    qb = (
      qb.match()
      .node(ref_name="a", labels=[self.tenant_label, entity_type], properties={PRIMARY_ID_KEY: entity_pk})  # type: ignore
      .related(ref_name="r")
      .node(ref_name="b", labels=[self.tenant_label])  # type: ignore - ensure other node also has tenant_label
      .return_literal("a,r,b")
    )

    query = str(qb)
    logger.debug(query)
    async with self.driver.session(default_access_mode=neo4j.READ_ACCESS, database=self.database) as session:
      res = await session.run(query)  # type: ignore
      records: list[Record] = await res.fetch(max_results)
      relations = []
      for record in records:
        relationship: Relationship = record.value("r")
        relation_name = relationship.type
        relation_props = dict(relationship.items())

        from_entity_raw = relationship.start_node
        to_entity_raw = relationship.end_node

        if from_entity_raw is None or to_entity_raw is None:
          continue

        from_entity_type = from_entity_raw.get(ENTITY_TYPE_KEY)
        from_additional_types = set(from_entity_raw.labels)
        from_additional_types.discard(from_entity_type)
        from_additional_types.discard(self.tenant_label)

        to_entity_type = to_entity_raw.get(ENTITY_TYPE_KEY)
        to_additional_types = set(to_entity_raw.labels)
        to_additional_types.discard(to_entity_type)
        to_additional_types.discard(self.tenant_label)

        from_entity = StructuredEntity(
          entity_type=from_entity_type,
          primary_key_properties=from_entity_raw[ALL_IDS_PROPS_KEY][0].split(PROP_DELIMITER),
          additional_key_properties=[k.split(PROP_DELIMITER) for k in from_entity_raw[ALL_IDS_PROPS_KEY][1:]],
          additional_types=from_additional_types,
          all_properties=dict(from_entity_raw),
        )

        to_entity = StructuredEntity(
          entity_type=to_entity_type, primary_key_properties=to_entity_raw[ALL_IDS_PROPS_KEY][0].split(PROP_DELIMITER), additional_key_properties=[k.split(PROP_DELIMITER) for k in to_entity_raw[ALL_IDS_PROPS_KEY][1:]], additional_types=to_additional_types, all_properties=dict(to_entity_raw)
        )

        relation = Relation(from_entity=from_entity.get_identifier(), to_entity=to_entity.get_identifier(), relation_name=relation_name, relation_pk=relation_props.get(RELATION_PK_KEY, ""), relation_properties=relation_props)

        relations.append(relation)

      return relations

  async def update_entity(self, entity_type: str, entities: List[StructuredEntity]):
    """
    Batch update entities of a single type in the graph database (Creates if it does not exist).
    This is a backwards-compatible wrapper around update_entity_batch().

    :param entity_type: type of entity (for backwards compatibility, but not used)
    :param entities: list of entities to update
    """
    await self.update_entity_batch(entities, batch_size=1000)

  async def update_entity_batch(self, entities: List[StructuredEntity], batch_size: int = 1000):
    """
    Create or update a list of entities in the database using batched CALL + UNWIND queries.
    This method groups entities by (entity_type, additional_types) and executes all updates
    in a SINGLE network call for maximum performance.

    :param entities: The list of entities to create/update (can be mixed types).
    :param batch_size: Maximum number of entities to process per database call (default: 1000).
    """
    logger.debug(f"Updating {len(entities)} entities in batch (batch_size={batch_size})")

    # Return if no entities provided
    if not entities:
      return

    # Group entities by (entity_type, frozenset(additional_types))
    from collections import defaultdict

    grouped_entities = defaultdict(list)

    for entity in entities:
      # Create a hashable key for grouping
      labels_key = frozenset(entity.additional_types) if entity.additional_types else frozenset()
      group_key = (entity.entity_type, labels_key)
      grouped_entities[group_key].append(entity)

    logger.debug(f"Grouped {len(entities)} entities into {len(grouped_entities)} groups by type and labels")
    if len(grouped_entities) == 1:
      logger.debug(f"Group: {list(grouped_entities.items())}")

    # Build parameters for each group
    all_group_params = []
    call_blocks = []

    for group_idx, ((entity_type, labels_set), group_entities) in enumerate(grouped_entities.items()):
      # Prepare parameters for this group
      batch_params = []

      for entity in group_entities:
        try:
          # 1. Generate primary key
          primary_key_val = entity.generate_primary_key()

          # 2. Collect all identity values and properties
          all_id_vals = [entity.all_properties[k] for k in entity.primary_key_properties]
          all_id_props = [PROP_DELIMITER.join(map(str, entity.primary_key_properties))]
          if entity.additional_key_properties:
            for id_keys in entity.additional_key_properties:
              try:
                vals = [entity.all_properties[prop] for prop in id_keys]
                all_id_vals.extend(vals)
                all_id_props.append(PROP_DELIMITER.join(map(str, id_keys)))
              except KeyError as e:
                logger.warning(f"Skipping additional key for entity {primary_key_val}: property {e} not found.")

          # 3. Assemble the complete properties dictionary for the query
          entity_params = entity.all_properties.copy()
          entity_params.update({ENTITY_TYPE_KEY: entity.entity_type, ALL_IDS_KEY: all_id_vals, ALL_IDS_PROPS_KEY: all_id_props, PRIMARY_ID_KEY: primary_key_val})

          # 4. Sanitize properties for Neo4j compatibility
          entity_params = sanitize_entity_properties(entity_params)

          batch_params.append(entity_params)

        except Exception as e:
          logger.error(f"Failed to process entity {entity}: {e}", exc_info=True)

      if not batch_params:
        logger.warning(f"No valid entities in group {group_idx}")
        continue

      # Store params with a unique key for this group
      param_key = f"batch_{group_idx}"
      all_group_params.append((param_key, batch_params))

      # Construct labels string for this group
      labels = {self.tenant_label, entity_type}
      if labels_set:
        labels.update(labels_set)
      labels_str = ":".join(map(self._escape_label, labels))

      # Build CALL block for this group (Neo4j 5.x requires () for variable scope)
      base_label = self._escape_label(self.tenant_label)
      call_block = f"""
            CALL () {{
                UNWIND ${param_key} as properties
                MERGE (e:{base_label} {{`{ENTITY_TYPE_KEY}`: properties.`{ENTITY_TYPE_KEY}`, `{PRIMARY_ID_KEY}`: properties.`{PRIMARY_ID_KEY}`}})
                SET e:{labels_str}
                SET e = properties
            }}"""
      call_blocks.append(call_block)

      logger.debug(f"Group {group_idx}: {len(batch_params)} entities of type '{entity_type}' with labels {labels}")

    if not call_blocks:
      logger.warning("No valid entity groups to update")
      return

    # Combine all CALL blocks into a single query
    query = "\n".join(call_blocks)

    # Build parameters dict with all batches
    params = {key: batch for key, batch in all_group_params}

    logger.debug(f"Executing batch update for {len(entities)} entities across {len(call_blocks)} groups in ONE query")
    logger.debug(f"Query structure: {len(call_blocks)} CALL blocks")

    max_retries = 5
    for attempt in range(max_retries):
      try:
        async with self.driver.session(database=self.database) as session:
          result = await session.run(query, params)  # type: ignore
          summary = await result.consume()
          logger.debug(f"Query result - Counters: {summary.counters}")
          logger.debug(f"Query result - Notifications: {summary.notifications}")
          logger.debug(f"Query result - Status Objects: {summary.gql_status_objects}")
        logger.info(f"Successfully updated {len(entities)} entities across {len(call_blocks)} groups in ONE network call to {self.uri}")
        break  # Success
      except Exception as e:
        if attempt < max_retries - 1:
          logger.warning(f"Neo4j batch query failed (attempt {attempt + 1}/{max_retries}): {e}")
          await asyncio.sleep(1)  # Wait before retry
        else:
          logger.error(f"Neo4j batch query failed after {max_retries} attempts: {e}", exc_info=True)
          raise

  async def update_relation(self, relation: Relation):
    """
    Update a single relationship between two entities in the graph database.
    This is a backwards-compatible wrapper around update_relation_batch().

    :param relation: relation to update
    """
    await self.update_relation_batch([relation], batch_size=1000)

  async def update_relation_batch(self, relations: List[Relation], batch_size: int = 1000):
    """
    Create or update a list of relations in the database using batched CALL + UNWIND queries.
    This method groups relations by relation_name and executes all updates in a SINGLE network call
    for maximum performance.

    :param relations: The list of relations to create/update.
    :param batch_size: Maximum number of relations to process per database call (default: 1000).
    """
    logger.debug(f"Updating {len(relations)} relations in batch (batch_size={batch_size})")

    # Return if no relations provided
    if not relations:
      return

    # Group relations by relation_name for efficient batching
    from collections import defaultdict

    grouped_relations = defaultdict(list)

    for relation in relations:
      if relation.from_entity.entity_type is None or relation.to_entity.entity_type is None:
        logger.warning(f"Skipping relation with missing entity types: {relation}")
        continue
      if not relation.relation_pk:
        logger.error(f"Skipping relation without relation_pk: {relation}")
        continue
      grouped_relations[relation.relation_name].append(relation)

    logger.debug(f"Grouped {len(relations)} relations into {len(grouped_relations)} groups by relation_name")

    # Build parameters for each group
    all_group_params = []
    call_blocks = []

    for group_idx, (relation_name, group_relations) in enumerate(grouped_relations.items()):
      # Prepare parameters for this group
      batch_params = []

      for relation in group_relations:
        try:
          # Sanitize relation properties for Neo4j compatibility
          properties = {}
          if relation.relation_properties is not None:
            properties = sanitize_entity_properties(relation.relation_properties)

          # Ensure relation_pk is in properties
          properties[RELATION_PK_KEY] = relation.relation_pk

          # Build relation parameter object
          rel_param = {"from_type": relation.from_entity.entity_type, "from_pk": relation.from_entity.primary_key, "to_type": relation.to_entity.entity_type, "to_pk": relation.to_entity.primary_key, "properties": properties}
          batch_params.append(rel_param)

        except Exception as e:
          logger.error(f"Failed to process relation {relation}: {e}", exc_info=True)

      if not batch_params:
        logger.warning(f"No valid relations in group {group_idx}")
        continue

      # Store params with a unique key for this group
      param_key = f"batch_{group_idx}"
      all_group_params.append((param_key, batch_params))

      # Escape labels and relation name
      escaped_tenant = self._escape_label(self.tenant_label)
      escaped_relation_name = self._escape_label(relation_name)

      # Build CALL block for this group (Neo4j 5.x requires () for variable scope)
      # We need to dynamically match nodes with different types, so we use UNWIND
      # MERGE uses relation_pk from properties to uniquely identify relations
      call_block = f"""
            CALL () {{
                UNWIND ${param_key} as rel
                MATCH (f:{escaped_tenant} {{`{ENTITY_TYPE_KEY}`: rel.from_type, `{PRIMARY_ID_KEY}`: rel.from_pk}})
                MATCH (t:{escaped_tenant} {{`{ENTITY_TYPE_KEY}`: rel.to_type, `{PRIMARY_ID_KEY}`: rel.to_pk}})
                MERGE (f)-[r:{escaped_relation_name} {{`{RELATION_PK_KEY}`: rel.properties.`{RELATION_PK_KEY}`}}]->(t)
                SET r = rel.properties
            }}"""
      call_blocks.append(call_block)

      logger.debug(f"Group {group_idx}: {len(batch_params)} relations of type '{relation_name}")

    if not call_blocks:
      logger.warning("No valid relation groups to update")
      return

    # Combine all CALL blocks into a single query
    query = "\n".join(call_blocks)

    # Build parameters dict with all batches
    params = {key: batch for key, batch in all_group_params}

    logger.debug(f"Query: {query}")
    logger.debug(f"Params: {params}")
    logger.debug(f"Executing batch update for {len(relations)} relations across {len(call_blocks)} groups in ONE query")
    logger.debug(f"Query structure: {len(call_blocks)} CALL blocks")

    max_retries = 5
    for attempt in range(max_retries):
      try:
        async with self.driver.session(database=self.database) as session:
          result = await session.run(query, params)  # type: ignore
          summary = await result.consume()
          logger.debug(f"Query result - Counters: {summary.counters}")
          logger.debug(f"Query result - Notifications: {summary.notifications}")
          logger.debug(f"Query result - Status Objects: {summary.gql_status_objects}")
        logger.debug(f"Successfully updated {len(relations)} relations across {len(call_blocks)} groups in ONE network call to {self.uri}")
        break  # Success
      except Exception as e:
        if attempt < max_retries - 1:
          logger.warning(f"Neo4j batch relation query failed (attempt {attempt + 1}/{max_retries}): {e}")
          await asyncio.sleep(1)  # Wait before retry
        else:
          logger.error(f"Neo4j batch relation query failed after {max_retries} attempts: {e}", exc_info=True)
          raise

  async def shortest_path(self, entity_a: StructuredEntityId, entity_b: StructuredEntityId, ignore_direction=True, max_depth=20) -> List[Tuple[List[StructuredEntity], List[Relation]]]:
    """
    Finds all shortest paths between two entities in the graph database
    :param entity_a: StructuredEntityId of the first entity
    :param entity_b: StructuredEntityId of the second entity
    :param ignore_direction: If True, treat relationships as undirected
    :param max_depth: Maximum path length to search
    :return: A list of tuples, each containing (entities_path, relations_path)
    """
    logger.debug(f"Executing shortest_path with entity_a={entity_a}, entity_b={entity_b}, ignore_direction={ignore_direction}, max_depth={max_depth}")
    if ignore_direction:
      relationship_pattern = f"-[*1..{max_depth}]-"
    else:
      relationship_pattern = f"-[*1..{max_depth}]->"

    # Include tenant_label in both start and end nodes
    escaped_tenant_label = self._escape_label(self.tenant_label)
    query = f"""
        MATCH (start:{escaped_tenant_label}:{entity_a.entity_type} {{`{PRIMARY_ID_KEY}`: $start_id}})
        MATCH (end:{escaped_tenant_label}:{entity_b.entity_type} {{`{PRIMARY_ID_KEY}`: $end_id}})
        MATCH path = allShortestPaths((start){relationship_pattern}(end))
        RETURN path
        """

    params = {"start_id": entity_a.primary_key, "end_id": entity_b.primary_key, "max_depth": max_depth}

    logger.debug(query)
    logger.debug(params)

    async with self.driver.session(default_access_mode=neo4j.READ_ACCESS, database=self.database) as session:
      res = await session.run(query, params)  # type: ignore
      records: list[Record] = await res.fetch(1000)

      paths = []
      for record in records:
        path = record["path"]

        # Extract entities from path nodes
        entities = []
        for node in path.nodes:
          node_props = dict(node)
          labels = set(node.labels)
          entity_type = node_props[ENTITY_TYPE_KEY]
          labels.discard(entity_type)
          labels.discard(self.tenant_label)

          entity = StructuredEntity(entity_type=entity_type, primary_key_properties=node_props[ALL_IDS_PROPS_KEY][0].split(PROP_DELIMITER), additional_key_properties=[k.split(PROP_DELIMITER) for k in node_props[ALL_IDS_PROPS_KEY][1:]], additional_types=labels, all_properties=node_props)
          entities.append(entity)

        # Extract relations from path relationships
        relations = []
        for relationship in path.relationships:
          relation_props = dict(relationship.items())

          # Get start and end node info
          start_node = relationship.start_node
          end_node = relationship.end_node

          from_entity_id = StructuredEntityId(entity_type=start_node.get(ENTITY_TYPE_KEY), primary_key=start_node.get(PRIMARY_ID_KEY))

          to_entity_id = StructuredEntityId(entity_type=end_node.get(ENTITY_TYPE_KEY), primary_key=end_node.get(PRIMARY_ID_KEY))

          relation = Relation(from_entity=from_entity_id, to_entity=to_entity_id, relation_name=relationship.type, relation_pk=relation_props.get(RELATION_PK_KEY, ""), relation_properties=relation_props)
          relations.append(relation)

        paths.append((entities, relations))

      return paths

  async def remove_entity(self, entity_type: str | None, properties: (dict | None) = None):
    """
    Removes an entity from the graph database
    :param entity_type: type of the entity to remove
    :param properties: dict of properties to match
    """
    logger.debug(f"Executing remove_entity with entity_type={entity_type}, properties={properties}")
    # Build the MATCH clause - always include tenant_label
    escaped_tenant_label = self._escape_label(self.tenant_label)
    if entity_type is None or entity_type == "":
      match_clause = f"MATCH (n:{escaped_tenant_label})"
    else:
      escaped_entity_type = self._escape_label(entity_type)
      match_clause = f"MATCH (n:{escaped_tenant_label}:{escaped_entity_type})"

    # Build WHERE clause and parameters
    where_conditions = []
    params = {}

    if properties is not None and len(properties) > 0:
      for key, value in properties.items():
        param_name = f"prop_{key}"
        where_conditions.append(f"n.`{key}` = ${param_name}")
        params[param_name] = value

    # Construct the full query
    if where_conditions:
      where_clause = "WHERE " + " AND ".join(where_conditions)
      query = f"{match_clause} {where_clause} DETACH DELETE n"
    else:
      query = f"{match_clause} DETACH DELETE n"

    logger.debug(query)
    logger.debug(params)

    async with self.driver.session(database=self.database) as session:
      await session.run(query, params)  # type: ignore

  async def remove_relation(self, relation_name: str, properties: (dict | None) = None):
    """
    Removes a relation from the graph database
    :param relation_name: name of the relation to remove
    :param properties: dict of properties to match
    """
    logger.debug(f"Executing remove_relation with relation_name={relation_name}, properties={properties}")
    if properties is None or len(properties) == 0:
      where_str = ""
    else:
      where_str = "WHERE "
      for key, value in properties.items():
        if where_str != "WHERE ":
          where_str += " AND "
        where_str += f"r.`{key}`='{value}'"

    if relation_name is None or relation_name == "":
      query = f"""
            MATCH (f:{self.tenant_label})-[r]->(t:{self.tenant_label}) {where_str} DETACH DELETE r
            """
    else:
      query = f"""
            MATCH (f:{self.tenant_label})-[r:{relation_name}]->(t:{self.tenant_label}) {where_str} DETACH DELETE r
            """

    logger.debug(query)
    async with self.driver.session(database=self.database) as session:
      await session.run(query)  # type: ignore

  async def remove_stale_entities(self, datasource_id: str | None = None) -> int:
    """
    Periodically clean up the database by removing entities that are older than the fresh until timestamp.

    Args:
      datasource_id: Optional filter to only clean specific datasource.

    Returns:
      True if cleanup completed successfully.
    """
    logger.debug(f"Removing stale entities from the database (datasource_id={datasource_id})")
    now = int(time.time())

    if datasource_id:
      query = f"""
          MATCH (n:{self.tenant_label}) 
          WHERE n.{FRESH_UNTIL_KEY} < {now} AND n.{DATASOURCE_ID_KEY} = $datasource_id
          DETACH DELETE n
          """
      params = {"datasource_id": datasource_id}
    else:
      query = f"""
          MATCH (n:{self.tenant_label}) 
          WHERE n.{FRESH_UNTIL_KEY} < {now}
          DETACH DELETE n
          """
      params = {}

    logger.debug(query)
    async with self.driver.session(database=self.database) as session:
      await session.run(query, params)  # type: ignore
      logger.info(f"Cleaned up stale entities from the database (datasource_id={datasource_id})")
      return True

  async def relate_entities_by_property(self, entity_a_type: str, entity_b_type: str, relation_type: str, matching_properties: dict, relation_pk: str, relation_properties: (dict | None) = None):
    """
    Relates two entity types by matching properties with specified match types.

    :param matching_properties: Dictionary where keys are entity_a properties and values are tuples of (entity_b_property, match_type)
                               Format: {"entity_a_prop": ("entity_b_prop", "exact"|"prefix"|"suffix"|"subset"|"superset"|"contains"|"none")}
                               Example: {"name": ("user_name", "prefix"), "id": ("user_id", "exact")}
    """
    logger.debug(f"Executing relate_entities_by_property with entity_a_type={entity_a_type}, entity_b_type={entity_b_type}, relation_type={relation_type}, matching_properties={matching_properties}, relation_pk={relation_pk}, relation_properties={relation_properties}")

    if not matching_properties or len(matching_properties) == 0:
      raise ValueError("matching_properties must be set and not empty")

    if not relation_pk:
      raise ValueError("relation_pk must be set and not empty")

    # Build WHERE clause with match type logic for each property mapping
    where_conditions = []
    for prop_a, (prop_b, match_type_value) in matching_properties.items():
      # Get string value from enum
      match_type = match_type_value.value if isinstance(match_type_value, ValueMatchType) else str(match_type_value)

      # Skip if match type is "none"
      if match_type == ValueMatchType.NONE.value:
        logger.debug(f"Skipping property {prop_a} with match_type='none'")
        continue

      if match_type == ValueMatchType.EXACT.value:
        # Exact match: direct equality
        condition = f"f.`{prop_a}` = t.`{prop_b}`"
      elif match_type == ValueMatchType.PREFIX.value:
        # Prefix match: f.prop starts with t.prop (for strings only)
        condition = f"f.`{prop_a}` STARTS WITH t.`{prop_b}`"
      elif match_type == ValueMatchType.SUFFIX.value:
        # Suffix match: f.prop ends with t.prop (for strings only)
        condition = f"f.`{prop_a}` ENDS WITH t.`{prop_b}`"
      elif match_type == ValueMatchType.CONTAINS.value:
        # Contains match: scalar/array containment (bidirectional)
        condition = f"(f.`{prop_a}` IN t.`{prop_b}` OR t.`{prop_b}` IN f.`{prop_a}`)"
      elif match_type == ValueMatchType.SUBSET.value:
        # Subset match: all values in f.prop are in t.prop (for arrays only)
        condition = f"ALL(x IN f.`{prop_a}` WHERE x IN t.`{prop_b}`)"
      elif match_type == ValueMatchType.SUPERSET.value:
        # Superset match: all values in t.prop are in f.prop (for arrays only)
        condition = f"ALL(x IN t.`{prop_b}` WHERE x IN f.`{prop_a}`)"
      else:
        # Unknown match type - fall back to exact
        logger.warning(f"Unknown match type '{match_type}', falling back to exact match")
        condition = f"f.`{prop_a}` = t.`{prop_b}`"

      where_conditions.append(condition)

    # If all mappings were "none", skip relation creation
    if not where_conditions:
      logger.info(f"All property mappings have match_type='none', skipping relation creation for {relation_pk}")
      return

    where_str = "WHERE " + " AND ".join(where_conditions)

    # Ensure relation_properties includes relation_pk
    if relation_properties is None:
      relation_properties = {}
    relation_properties[RELATION_PK_KEY] = relation_pk

    set_str = "SET "
    for key, value in relation_properties.items():
      if set_str != "SET ":
        set_str += " SET "
      set_str += f"r.`{key}`='{value}'"

    # Include tenant_label in both entity matches
    # MERGE uses relation_pk to uniquely identify relations
    escaped_tenant_label = self._escape_label(self.tenant_label)
    escaped_relation_type = self._escape_label(relation_type)
    query = "" + f"MATCH (f:{escaped_tenant_label}:{entity_a_type}) " + f"MATCH (t:{escaped_tenant_label}:{entity_b_type}) " + f"{where_str} " + f"MERGE (f)-[r:{escaped_relation_type} {{`{RELATION_PK_KEY}`: '{relation_pk}'}}]-(t) " + f"{set_str}"
    logger.debug(query)
    await self.raw_query(query)

  async def get_property_value_count(self, entity_type: str, property_name: str, property_value: Optional[str]) -> int:
    logger.debug(f"Executing get_property_value_count with entity_type={entity_type}, property_name={property_name}, property_value={property_value}")
    # Include tenant_label in the query
    escaped_tenant_label = self._escape_label(self.tenant_label)
    if property_value is not None:
      query = f"""
            MATCH (n:{escaped_tenant_label}:{entity_type}) WHERE n.`{property_name}`='{property_value}'
            RETURN COUNT(n) AS count
            """
    else:
      query = f"""
            MATCH (n:{escaped_tenant_label}:{entity_type}) WHERE n.`{property_name}` IS NOT NULL
            RETURN COUNT(n) AS count
            """

    logger.debug(query)
    result = await self.raw_query(query)
    return result["results"][0].get("count", 0)

  async def get_values_of_matching_property(self, entity_type_a: str, entity_a_property: str, entity_type_b: str, matching_properties: dict, max_results: int = 10) -> List[str]:
    logger.debug(f"Executing get_values_of_matching_property with entity_type_a={entity_type_a}, entity_a_property={entity_a_property}, entity_type_b={entity_type_b}, matching_properties={matching_properties}, max_results={max_results}")

    where_str = "WHERE "
    for matching_property_a, matching_property_b in matching_properties.items():
      if where_str != "WHERE ":
        where_str += " AND "
      where_str += f"(f.`{matching_property_a}`=t.`{matching_property_b}` OR f.`{matching_property_a}` IN t.`{matching_property_b}` OR t.`{matching_property_b}` IN f.`{matching_property_a}`)"

    # Include tenant_label in both entity matches
    escaped_tenant_label = self._escape_label(self.tenant_label)
    query = (
      f"MATCH (f:{escaped_tenant_label}:{entity_type_a}) " + f"MATCH (t:{escaped_tenant_label}:{entity_type_b}) " + f"{where_str} " + f"RETURN distinct(f.`{entity_a_property}`) as values LIMIT {max_results}"
    )  # Using the to varialbe to return, as idkey property are not likely to be list (not supported)

    logger.debug(query)
    result = await self.raw_query(query)
    logger.debug(f"Query result: {result}")
    results = result.get("results", [])
    if len(results) == 0:
      return []
    vals = []
    # Extract the values from the results
    for result in results:
      vals.append(result.get("values", ""))
    return vals

  async def delete_relations_by_properties(self, properties: dict, properties_negated: dict | None = None, from_entity_type: str | None = None, to_entity_type: str | None = None, relation_name: str | None = None) -> int:
    """
    Delete relations that match the given property filters.

    :param properties: Dictionary of properties to match on the relation using = operator
    :param properties_negated: Dictionary of properties to match using <> operator
    :param from_entity_type: Optional filter by source entity type
    :param to_entity_type: Optional filter by target entity type
    :param relation_name: Optional filter by relation name
    :return: Number of relations deleted
    """
    logger.debug(f"Executing delete_relations_by_properties with properties={properties}, properties_negated={properties_negated}, from_entity_type={from_entity_type}, to_entity_type={to_entity_type}, relation_name={relation_name}")

    if not properties and not properties_negated:
      raise ValueError("At least one of properties or properties_negated must be provided")

    # Build the MATCH clause
    escaped_tenant = self._escape_label(self.tenant_label)

    if from_entity_type:
      escaped_from = self._escape_label(from_entity_type)
      from_pattern = f"(:{escaped_tenant}:{escaped_from})"
    else:
      from_pattern = f"(:{escaped_tenant})"

    if to_entity_type:
      escaped_to = self._escape_label(to_entity_type)
      to_pattern = f"(:{escaped_tenant}:{escaped_to})"
    else:
      to_pattern = f"(:{escaped_tenant})"

    if relation_name:
      escaped_rel = self._escape_label(relation_name)
      rel_pattern = f"[r:{escaped_rel}]"
    else:
      rel_pattern = "[r]"

    # Build WHERE clause with property filters
    where_conditions = []
    params = {}

    # Add positive property filters (=)
    if properties:
      for key, value in properties.items():
        param_name = f"prop_{key.replace('.', '_').replace('`', '').replace('-', '_')}"
        where_conditions.append(f"r.`{key}` = ${param_name}")
        params[param_name] = value

    # Add negated property filters (<>)
    if properties_negated:
      for key, value in properties_negated.items():
        param_name = f"neg_{key.replace('.', '_').replace('`', '').replace('-', '_')}"
        where_conditions.append(f"r.`{key}` <> ${param_name}")
        params[param_name] = value

    where_clause = "WHERE " + " AND ".join(where_conditions)

    # Build the complete query - use undirected pattern to match both directions
    query = f"""
        MATCH {from_pattern}-{rel_pattern}-{to_pattern}
        {where_clause}
        DELETE r
        RETURN count(r) as deleted_count
        """

    logger.debug(query)
    logger.debug(params)

    async with self.driver.session(database=self.database) as session:
      res = await session.run(query, params)  # type: ignore
      record = await res.single()
      deleted_count = record.get("deleted_count", 0) if record else 0
      logger.info(f"Deleted {deleted_count} relations matching properties={properties}, properties_negated={properties_negated}")
      return deleted_count

  async def delete_entities_by_properties(self, properties: dict, properties_negated: dict | None = None, entity_type: str | None = None) -> int:
    """
    Delete entities (and their relations) that match the given property filters.
    Uses DETACH DELETE to remove all relations as well.

    :param properties: Dictionary of properties to match using = operator
    :param properties_negated: Dictionary of properties to match using <> operator
    :param entity_type: Optional filter by entity type
    :return: Number of entities deleted
    """
    logger.debug(f"Executing delete_entities_by_properties with properties={properties}, properties_negated={properties_negated}, entity_type={entity_type}")

    if not properties and not properties_negated:
      raise ValueError("At least one of properties or properties_negated must be provided")

    # Build the MATCH clause
    escaped_tenant = self._escape_label(self.tenant_label)

    if entity_type:
      escaped_type = self._escape_label(entity_type)
      match_clause = f"MATCH (n:{escaped_tenant}:{escaped_type})"
    else:
      match_clause = f"MATCH (n:{escaped_tenant})"

    # Build WHERE clause with property filters
    where_conditions = []
    params = {}

    # Add positive property filters (=)
    if properties:
      for key, value in properties.items():
        param_name = f"prop_{key.replace('.', '_').replace('`', '').replace('-', '_')}"
        where_conditions.append(f"n.`{key}` = ${param_name}")
        params[param_name] = value

    # Add negated property filters (<>)
    if properties_negated:
      for key, value in properties_negated.items():
        param_name = f"neg_{key.replace('.', '_').replace('`', '').replace('-', '_')}"
        where_conditions.append(f"n.`{key}` <> ${param_name}")
        params[param_name] = value

    where_clause = "WHERE " + " AND ".join(where_conditions)

    # Build the complete query
    query = f"""
        {match_clause}
        {where_clause}
        DETACH DELETE n
        RETURN count(n) as deleted_count
        """

    logger.debug(query)
    logger.debug(params)

    async with self.driver.session(database=self.database) as session:
      res = await session.run(query, params)  # type: ignore
      record = await res.single()
      deleted_count = record.get("deleted_count", 0) if record else 0
      logger.info(f"Deleted {deleted_count} entities matching properties={properties}, properties_negated={properties_negated}")
      return deleted_count

  async def raw_query(self, query: str, readonly=False, max_results=10000) -> dict:
    logger.debug(f"Executing raw_query with query_length={len(query)}, readonly={readonly}, max_results={max_results}")
    if readonly:
      session = self.driver.session(default_access_mode=neo4j.READ_ACCESS, database=self.database)
    else:
      session = self.driver.session(database=self.database)
    async with session:
      res = await session.run(query)  # type: ignore
      # d = await res.data()
      rec = await res.fetch(max_results)
      logger.debug(f"Query returned {len(rec)} records")
      d = await res.consume()
      return {"results": rec, "notifications": d.notifications}

  async def explore_neighborhood(self, entity_type: str, entity_pk: str, depth: int = 1, max_results: int = 1000) -> dict:
    """
    Explore the neighborhood of an entity up to a given depth.
    Returns entities and relations within the specified depth from the starting entity.

    :param entity_type: Type of the entity (corresponds to label in Neo4j)
    :param entity_pk: Primary key of the starting entity (unique within entity_type)
    :param depth: Maximum depth to explore (0 = just the entity, 1 = direct neighbors, etc.)
    :param max_results: Maximum number of results to return
    :return: Dictionary containing:
        - entity: The starting entity (if found)
        - entities: List of entities within the neighborhood
        - relations: List of relations within the neighborhood
    """
    logger.debug(f"Exploring neighborhood for entity_type={entity_type}, entity_pk={entity_pk}, depth={depth}, max_results={max_results}")

    # Find the starting entity with both tenant_label and entity_type labels
    escaped_tenant = self._escape_label(self.tenant_label)
    escaped_entity_type = self._escape_label(entity_type)

    # If depth is 0, just return the entity
    if depth == 0:
      query = f"""
            MATCH (n:{escaped_tenant}:{escaped_entity_type} {{`{PRIMARY_ID_KEY}`: $entity_pk}})
            RETURN n
            LIMIT 1
            """

      async with self.driver.session(default_access_mode=neo4j.READ_ACCESS, database=self.database) as session:
        res = await session.run(query, {"entity_pk": entity_pk})  # type: ignore
        records = await res.fetch(1)

        if not records:
          return {"entity": None, "entities": [], "relations": []}

        node = records[0]["n"]
        props = dict(node)
        labels = set(node.labels)
        labels.discard(props[ENTITY_TYPE_KEY])
        labels.discard(self.tenant_label)

        entity = StructuredEntity(entity_type=props[ENTITY_TYPE_KEY], primary_key_properties=props[ALL_IDS_PROPS_KEY][0].split(PROP_DELIMITER), additional_key_properties=[k.split(PROP_DELIMITER) for k in props[ALL_IDS_PROPS_KEY][1:]], additional_types=labels, all_properties=props)

        return {"entity": entity, "entities": [entity], "relations": []}

    # For depth > 0, use variable-length path matching with list comprehensions
    # This ensures we always return the start node even if there are no relations
    query = f"""
        MATCH (start:{escaped_tenant}:{escaped_entity_type} {{`{PRIMARY_ID_KEY}`: $entity_pk}})
        OPTIONAL MATCH path = (start)-[*1..{depth}]-(n:{escaped_tenant})
        WITH start,
             collect(DISTINCT n) AS neighbors,
             collect(DISTINCT path) AS paths
        WITH start, neighbors,
             [path IN paths WHERE path IS NOT NULL | relationships(path)] AS path_rels
        WITH start, neighbors,
             reduce(flat = [], rels IN path_rels | flat + rels) AS all_rels
        WITH start, neighbors,
             [r IN all_rels | r] AS rels
        RETURN start, neighbors, rels
        LIMIT {max_results}
        """

    logger.debug(f"Executing neighborhood query: {query}")

    async with self.driver.session(default_access_mode=neo4j.READ_ACCESS, database=self.database) as session:
      res = await session.run(query, {"entity_pk": entity_pk})  # type: ignore
      record = await res.single()

      if not record:
        return {"entity": None, "entities": [], "relations": []}

      # Parse starting entity
      start_node: Node = record["start"]
      start_props = dict(start_node)
      start_labels = set(start_node.labels)
      start_labels.discard(start_props[ENTITY_TYPE_KEY])
      start_labels.discard(self.tenant_label)

      start_entity = StructuredEntity(
        entity_type=start_props[ENTITY_TYPE_KEY], primary_key_properties=start_props[ALL_IDS_PROPS_KEY][0].split(PROP_DELIMITER), additional_key_properties=[k.split(PROP_DELIMITER) for k in start_props[ALL_IDS_PROPS_KEY][1:]], additional_types=start_labels, all_properties=start_props
      )

      # Parse neighbor entities
      entities = [start_entity]
      neighbor_nodes: List[Node] = record.get("neighbors", [])

      for node in neighbor_nodes:
        if node is None:
          continue
        props = dict(node)
        labels = set(node.labels)
        labels.discard(props[ENTITY_TYPE_KEY])
        labels.discard(self.tenant_label)

        entity = StructuredEntity(entity_type=props[ENTITY_TYPE_KEY], primary_key_properties=props[ALL_IDS_PROPS_KEY][0].split(PROP_DELIMITER), additional_key_properties=[k.split(PROP_DELIMITER) for k in props[ALL_IDS_PROPS_KEY][1:]], additional_types=labels, all_properties=props)
        entities.append(entity)

      # Parse relations
      relations = []
      rel_list: List[Relationship] = record.get("rels", [])

      for rel in rel_list:
        if rel is None:
          continue

        relation_props = dict(rel.items())
        start_node_rel = rel.start_node
        end_node_rel = rel.end_node

        if start_node_rel is None or end_node_rel is None:
          continue

        from_entity_id = StructuredEntityId(entity_type=start_node_rel.get(ENTITY_TYPE_KEY), primary_key=start_node_rel.get(PRIMARY_ID_KEY))

        to_entity_id = StructuredEntityId(entity_type=end_node_rel.get(ENTITY_TYPE_KEY), primary_key=end_node_rel.get(PRIMARY_ID_KEY))

        relation = Relation(from_entity=from_entity_id, to_entity=to_entity_id, relation_name=rel.type, relation_pk=relation_props.get(RELATION_PK_KEY, ""), relation_properties=relation_props)
        relations.append(relation)

      logger.info(f"Found {len(entities)} entities and {len(relations)} relations at depth {depth}")
      return {"entity": start_entity, "entities": entities, "relations": relations}

  async def get_graph_stats(self, datasource_ids: List[str] | None = None) -> dict:
    """
    Get statistics about the graph database.
    """
    logger.debug("Getting graph statistics")

    escaped_tenant = self._escape_label(self.tenant_label)

    node_conditions = [f"n.`{ENTITY_TYPE_KEY}` <> '{escaped_tenant}'"]
    rel_where = ""
    params: dict[str, Any] = {}
    if datasource_ids is not None:
      node_conditions.append(f"n.`{DATASOURCE_ID_KEY}` IN $datasource_ids")
      rel_where = f"WHERE a.`{DATASOURCE_ID_KEY}` IN $datasource_ids AND b.`{DATASOURCE_ID_KEY}` IN $datasource_ids"
      params["datasource_ids"] = datasource_ids

    # Count nodes
    node_query = f"""
        MATCH (n:{escaped_tenant})
        WHERE {" AND ".join(node_conditions)}
        RETURN COUNT(n) as count
        """

    # Count relations
    rel_query = f"""
        MATCH (a:{escaped_tenant})-[r]-(b:{escaped_tenant})
        {rel_where}
        RETURN COUNT(r) as count
        """

    async with self.driver.session(default_access_mode=neo4j.READ_ACCESS, database=self.database) as session:
      # Get node count
      res = await session.run(node_query, params)  # type: ignore
      node_record = await res.single()
      node_count = node_record.get("count", 0) if node_record else 0

      # Get relation count (divide by 2 because undirected)
      res = await session.run(rel_query, params)  # type: ignore
      rel_record = await res.single()
      relation_count = rel_record.get("count", 0) if rel_record else 0
      relation_count = relation_count // 2  # Divide by 2 for undirected relations

      logger.info(f"Graph stats: {node_count} nodes, {relation_count} relations")
      return {"node_count": node_count, "relation_count": relation_count}

  async def fetch_random_entities(
    self,
    count: int = 10,
    entity_type: str | None = None,
    datasource_ids: List[str] | None = None,
  ) -> List[StructuredEntity]:
    """
    Fetch random entities from the graph database.
    """
    logger.debug(f"Fetching {count} random entities, entity_type={entity_type}")

    escaped_tenant = self._escape_label(self.tenant_label)

    if entity_type:
      escaped_type = self._escape_label(entity_type)
      match_clause = f"MATCH (n:{escaped_tenant}:{escaped_type})"
    else:
      match_clause = f"MATCH (n:{escaped_tenant})"

    where_conditions = [f"n.`{ENTITY_TYPE_KEY}` <> '{escaped_tenant}'"]
    params: dict[str, Any] = {}
    if datasource_ids is not None:
      where_conditions.append(f"n.`{DATASOURCE_ID_KEY}` IN $datasource_ids")
      params["datasource_ids"] = datasource_ids

    # Use ORDER BY rand() for random sampling
    query = f"""
        {match_clause}
        WHERE {" AND ".join(where_conditions)}
        RETURN n
        ORDER BY rand()
        LIMIT {count}
        """

    logger.debug(query)

    async with self.driver.session(default_access_mode=neo4j.READ_ACCESS, database=self.database) as session:
      res = await session.run(query, params)  # type: ignore
      records = await res.fetch(count)

      entities = []
      for record in records:
        node: Node = record["n"]
        props = dict(node)
        labels = set(node.labels)
        labels.discard(props[ENTITY_TYPE_KEY])
        labels.discard(self.tenant_label)

        entity = StructuredEntity(entity_type=props[ENTITY_TYPE_KEY], primary_key_properties=props[ALL_IDS_PROPS_KEY][0].split(PROP_DELIMITER), additional_key_properties=[k.split(PROP_DELIMITER) for k in props[ALL_IDS_PROPS_KEY][1:]], additional_types=labels, all_properties=props)
        entities.append(entity)

      logger.info(f"Fetched {len(entities)} random entities")
      return entities

  async def _create_full_text_index(self, index_name: str, labels: list, props: list, analyzer: str = "simple"):
    props = [f"n.`{prop}`" for prop in props]
    props_str = ",".join(props)
    query = f"""
        CREATE FULLTEXT INDEX {index_name} IF NOT EXISTS FOR (n:{"|".join(labels)}) ON EACH [{props_str}]
        OPTIONS {{
          indexConfig: {{
            `fulltext.analyzer`: '{analyzer}'
          }}
        }}
        """
    logger.debug(query)
    async with self.driver.session(database=self.database) as session:
      await session.run(query)  # type: ignore

  async def _create_text_index(self, index_name: str, labels: list, props: list):
    props = [f"n.{prop}" for prop in props]
    props_str = ",".join(props)
    query = f"""
        CREATE TEXT INDEX {index_name} IF NOT EXISTS FOR (n:{"|".join(labels)}) ON ({props_str})
        """
    logger.debug(query)
    async with self.driver.session(database=self.database) as session:
      await session.run(query)  # type: ignore

  async def _create_range_index(self, index_name: str, labels: list, props: list):
    props = [f"n.{prop}" for prop in props]
    props_str = ",".join(props)
    query = f"""
        CREATE INDEX {index_name} IF NOT EXISTS FOR (n:{"|".join(labels)}) ON ({props_str})
        """
    logger.debug(query)
    async with self.driver.session(database=self.database) as session:
      await session.run(query)  # type: ignore

  async def _create_unique_constraint(self, label: str, props: list):
    query = f"CREATE CONSTRAINT {label}_unique IF NOT EXISTS FOR (n:{label}) REQUIRE ({', '.join([f'n.{prop}' for prop in props])}) IS UNIQUE"
    async with self.driver.session(database=self.database) as session:
      await session.run(query)  # type: ignore

  def _escape_label(self, label: str) -> str:
    return label.replace(":", "\\:")

  def _escape_str_value(self, v: Any) -> str:
    """
    Escape a value for use in a Cypher query.
    This is used to ensure that special characters do not break the query.
    """
    res = v.replace("\\", "\\\\").replace('"', '\\"').replace("'", "\\'").replace("\r", "\\r").replace("\n", "\\n")
    return res

  def _escape_keyword_lucene(self, keyword: str) -> str:
    lucene_special_chars = r'+-&&||!(){}[]^"~*?:\/'
    k = "".join(f"\\{char}" if char in lucene_special_chars else char for char in keyword)
    if k == "":
      return "''"
    return k
