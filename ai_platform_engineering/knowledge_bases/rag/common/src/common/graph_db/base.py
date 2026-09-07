from __future__ import annotations

from abc import ABC, abstractmethod
from typing import List, Optional, Tuple, Union
from common.models.rag import StructuredEntity, StructuredEntityId
from common.models.graph import Relation


class GraphDB(ABC):
  database_type: str
  query_language: str
  tenant_label: str  # Label used for multi-tenancy support

  @abstractmethod
  async def setup(self):
    """
    initialize the graph database, called once on startup.
    Must be idempotent, so it can be called multiple times without error
    """
    raise NotImplementedError("Subclasses must implement this method.")

  @abstractmethod
  async def status(self) -> bool:
    """
    Check the status of the graph database connection
    :return: True if the connection is healthy, False otherwise
    """
    raise NotImplementedError("Subclasses must implement this method.")

  @abstractmethod
  async def fuzzy_search_batch(self, batch_keywords: List[List[List[Union[str, Tuple[float, str]]]]], exclude_type_filter: List[str] = [], num_record_per_type: int = 0, require_single_match_per_type: bool = False, strict: bool = True, max_results=100) -> List[List[Tuple[StructuredEntity, float]]]:
    """
    Executes multiple fuzzy search queries in a batch for improved efficiency.
    Implementation should use a single database call (e.g., using UNWIND in Cypher) to minimize network overhead.

    :param batch_keywords: list of keyword queries, where each query follows the format:
                          keywords are OR'd in the same array, and AND'd across arrays.
                          Each keyword can be either a string or a (weight, string) tuple for relevance boosting.
                          E.g. batch_keywords = [
                              [['id1', (2.0, 'id2')], ['name1']],  # Query 1: (id1 OR id2^2.0) AND name1
                              [['id3'], ['name2', 'name3']]        # Query 2: id3 AND (name2 OR name3)
                          ]
    :param exclude_type_filter: exclude entity types in this list from results (shared across queries)
    :param num_record_per_type: Number of records to return per type, if 0, return all records, sorted by highest score
    :param strict: if True, the search is strict, meaning that the keywords must match exactly, if False, the search is fuzzy
    :param require_single_match_per_type: Only return records that have a single record matching for each type
    :param max_results: maximum number of results to return per query
    :return: list of results for each query, where each result is a list of tuples - matched entity, similarity
    """
    raise NotImplementedError("Subclasses must implement this method.")

  @abstractmethod
  async def get_all_entity_types(
    self,
    max_results: int = 1000,
    datasource_ids: List[str] | None = None,
  ) -> List[str]:
    """
    Returns all entity types in the graph database
    :param max_results: maximum number of distinct types to return
    :param datasource_ids: optional allowed datasource ids; an empty list returns no types
    :return: list of all entity types
    """
    raise NotImplementedError("Subclasses must implement this method.")

  @abstractmethod
  async def get_entity_count(self, entity_type: str | None = None) -> int:
    """
    Get the total count of entities in the graph database.

    Args:
        entity_type: Optional filter by entity type. If None, count all entities.

    Returns:
        int: Total number of entities
    """
    raise NotImplementedError("Subclasses must implement this method.")

  @abstractmethod
  async def get_entity_type_properties(self, entity_type: str, max_results=1000) -> List[str]:
    """
    Get all properties for a given entity type in the graph database.

    Args:
        entity_type (str): The type of entity to get properties for
        max_results (int): Maximum number of results to return

    Returns:
        List[str]: A list of all properties for the specified entity type
    """
    raise NotImplementedError("Subclasses must implement this method.")

  @abstractmethod
  async def fetch_entities_batch(
    self,
    offset: int = 0,
    limit: int = 10000,
    entity_type: str | None = None,
    datasource_ids: List[str] | None = None,
  ) -> List[StructuredEntity]:
    """
    Fetch entities in batches for efficient bulk processing.

    :param offset: Number of entities to skip (for pagination)
    :param limit: Maximum number of entities to return
    :param entity_type: Optional filter by entity type
    :param datasource_ids: Optional allowed datasource ids; an empty list returns no entities
    :return: List of entities in the batch
    """
    raise NotImplementedError("Subclasses must implement this method.")

  @abstractmethod
  async def fetch_raw_entity_batch(self, labels: List[str], properties: List[str], offset: int, limit: int, exclude_labels: List[str] = []) -> List[dict]:
    """
    Fetch raw entity properties in batches without pydantic parsing.
    Returns simple dictionaries with only the requested properties.

    :param labels: List of labels to match (e.g., ["NxsDataStructuredEntity"])
    :param properties: List of property names to return (e.g., ["_entity_pk", "_entity_type"])
    :param offset: Number of entities to skip (for pagination)
    :param limit: Maximum number of entities to return
    :param exclude_labels: List of labels to exclude from results (e.g., ["SomeLabel"])
    :return: List of dictionaries with requested properties
    """
    raise NotImplementedError("Subclasses must implement this method.")

  @abstractmethod
  async def find_entity(self, entity_type: str | None, properties: dict | None, max_results=10000) -> List[StructuredEntity]:
    """
    Finds an entity in the graph database
    :param entity_type: type of entity, empty for any
    :param properties: dict of properties to match
    :param max_results: maximum number of results to return
    :return: list of entities
    """
    raise NotImplementedError("Subclasses must implement this method.")

  @abstractmethod
  async def fetch_entity(self, entity_type: str, primary_key_value: str) -> StructuredEntity | None:
    """
    Gets a single entity by type and primary key value
    :param entity_type: type of entity
    :param primary_key_value: the primary key value of the entity
    :return: entity if found, None otherwise
    """
    raise NotImplementedError("Subclasses must implement this method.")

  @abstractmethod
  async def find_relations(self, from_entity_type: str | None = None, to_entity_type: str | None = None, relation_name: str | None = None, properties: dict | None = None, max_results: int = 10000) -> List[Relation]:
    """
    Finds relations between entities of specified types with given properties.
    :param from_entity_type: type of from entity, empty for any
    :param to_entity_type: type of to entity, empty for any
    :param relation_name: name of the relation, empty for any
    :param properties: dict of properties to match, None for any
    :param max_results: maximum number of results to return
    """
    raise NotImplementedError("Subclasses must implement this method.")

  @abstractmethod
  async def fetch_relations_batch(
    self,
    offset: int = 0,
    limit: int = 10000,
    relation_name: str | None = None,
    datasource_ids: List[str] | None = None,
  ) -> List[Relation]:
    """
    Fetch relations in batches for efficient bulk processing.

    :param offset: Number of relations to skip (for pagination)
    :param limit: Maximum number of relations to return
    :param relation_name: Optional filter by relation name
    :param datasource_ids: Optional allowed datasource ids for both endpoints
    :return: List of relations in the batch
    """
    raise NotImplementedError("Subclasses must implement this method.")

  @abstractmethod
  async def fetch_entity_relations(self, entity_type: str, entity_pk: str, max_results=10000) -> List[Relation]:
    """
    Gets relations of an entity in the graph database
    :param entity_type: type of entity
    :param entity_pk: the unique id of the entity
    :param max_results: maximum number of results to return
    :return: list of related entities and its relations
    """
    raise NotImplementedError("Subclasses must implement this method.")

  async def update_entity(self, entity_type: str, entities: List[StructuredEntity]):
    """
    Batch update entities of a single type in the graph database (Creates if it does not exist).
    This is a backwards-compatible wrapper that calls update_entity_batch().
    For updating multiple entity types efficiently, use update_entity_batch() directly.

    :param entity_type: type of entity (for backwards compatibility)
    :param entities: list of entities to update (must all be of the same type)
    """
    return await self.update_entity_batch(entities, batch_size=1000)

  @abstractmethod
  async def update_entity_batch(self, entities: List[StructuredEntity], batch_size: int = 1000):
    """
    Batch update entities in the graph database (Creates if it does not exist).
    This method handles grouping internally and executes all updates in minimal network calls.
    Use this method when updating many entities, especially of different types.

    :param entities: list of entities to update (can be mixed types)
    :param batch_size: maximum number of entities to process per database call
    """
    raise NotImplementedError("Subclasses must implement this method.")

  async def update_relation(self, relation: Relation):
    """
    Update a single relationship between two entities in the graph database.
    This is a backwards-compatible wrapper that calls update_relation_batch().
    For updating multiple relations efficiently, use update_relation_batch() directly.
    The uniqueness of the relation is determined by from_entity, to_entity and relation_name.

    :param relation: relation to update
    """
    return await self.update_relation_batch([relation], batch_size=1000)

  @abstractmethod
  async def update_relation_batch(self, relations: List[Relation], batch_size: int = 1000):
    """
    Batch update relations in the graph database (Creates if they do not exist).
    This method handles grouping internally and executes all updates in minimal network calls.
    Use this method when updating many relations.

    :param relations: list of relations to update
    :param batch_size: maximum number of relations to process per database call
    """
    raise NotImplementedError("Subclasses must implement this method.")

  @abstractmethod
  async def remove_entity(self, entity_type: str | None, properties: (dict | None) = None):
    """
    Removes an entity from the graph database
    :param entity_type: type of the entity to remove, None for any entity type
    :param properties: dict of properties to match
    """
    raise NotImplementedError("Subclasses must implement this method.")

  @abstractmethod
  async def remove_relation(self, relation_name: Optional[str], properties: (dict | None) = None):
    """
    Removes a relation from the graph database
    :param relation_name: name of the relation to remove
    :param properties: dict of properties to match
    """
    raise NotImplementedError("Subclasses must implement this method.")

  @abstractmethod
  async def remove_stale_entities(self, datasource_id: str | None = None) -> int:
    """
    Removes all entities that are stale (not updated for a long time).

    Args:
      datasource_id: Optional filter to only clean specific datasource.

    Returns:
      Number of entities deleted.
    """
    raise NotImplementedError("Subclasses must implement this method.")

  @abstractmethod
  async def relate_entities_by_property(self, entity_a_type: str, entity_b_type: str, relation_type: str, matching_properties: dict, relation_pk: str, relation_properties: (dict | None) = None):
    """
    Relates two entity types by matching properties in the graph database.

    :param entity_a_type: type of the first entity
    :param entity_b_type: type of the second entity
    :param relation_type: type of the relation to create
    :param matching_properties: Dictionary where keys are entity_a properties and values are tuples of (entity_b_property, match_type)
                               Format: {"entity_a_prop": ("entity_b_prop", "exact"|"prefix"|"suffix"|"subset"|"superset"|"contains"|"none")}
                               Example: {"name": ("user_name", "prefix"), "id": ("user_id", "exact")}
                               Match types:
                               - "exact": Direct equality or array containment
                               - "prefix": entity_a_prop starts with entity_b_prop (strings only)
                               - "suffix": entity_a_prop ends with entity_b_prop (strings only)
                               - "subset": All values in entity_a_prop are in entity_b_prop (arrays only)
                               - "superset": All values in entity_b_prop are in entity_a_prop (arrays only)
                               - "contains": Value is contained in array (arrays only)
                               - "none": Skip this property (no matching condition)
    :param relation_pk: primary key for the relation - used to uniquely identify relations with the same name between the same entity types
    :param relation_properties: optional dict of additional properties to set on the relation
    """
    raise NotImplementedError("Subclasses must implement this method.")

  @abstractmethod
  async def get_property_value_count(self, entity_type: str, property_name: str, property_value: Optional[str]) -> int:
    """
    Returns the count of values for a property in the graph database. (includes duplicates)
    If the property is an array, it counts every value in the array separately.
    :param entity_type: type of entity
    :param property_name: name of the property to match
    :param property_value: if specified, count only the entities with this property value, otherwise count all non-null values
    :return: count of values for the property
    """
    raise NotImplementedError("Subclasses must implement this method.")

  @abstractmethod
  async def get_values_of_matching_property(self, entity_type_a: str, entity_a_property: str, entity_type_b: str, matching_properties: dict, max_results: int = 10) -> List[str]:
    """
    Returns a list of values where two entity types have matching property value.
    :param entity_type_a: type of the first entity
    :param entity_a_property: property of the first entity
    :param entity_type_b: type of the second entity
    :param matching_properties: dict of properties to match between the two entities, keys are properties of entity_a_type, values are properties of entity_b_type
    :param max_results: maximum number of results to return
    :return: list of matching values
    """
    raise NotImplementedError("Subclasses must implement this method.")

  @abstractmethod
  async def shortest_path(self, entity_a: StructuredEntityId, entity_b: StructuredEntityId, ignore_direction=True, max_depth=20):
    """
    Finds all shortest paths between two entities in the graph database
    :param entity_a: StructuredEntityId of the first entity
    :param entity_b: StructuredEntityId of the second entity
    :param ignore_direction: If True, treat relationships as undirected
    :param max_depth: Maximum path length to search
    :return: A list of tuples, each containing (entities_path, relations_path)
    """
    raise NotImplementedError("Subclasses must implement this method.")

  @abstractmethod
  async def delete_relations_by_properties(self, properties: dict, properties_negated: dict | None = None, from_entity_type: str | None = None, to_entity_type: str | None = None, relation_name: str | None = None) -> int:
    """
    Delete relations that match the given property filters.

    :param properties: Dictionary of properties to match on the relation using = operator (e.g., {"updated_by": "client1"})
    :param properties_negated: Dictionary of properties to match using <> operator (e.g., {"_ontology_version_id": "v1"})
    :param from_entity_type: Optional filter by source entity type
    :param to_entity_type: Optional filter by target entity type
    :param relation_name: Optional filter by relation name
    :return: Number of relations deleted
    """
    raise NotImplementedError("Subclasses must implement this method.")

  @abstractmethod
  async def delete_entities_by_properties(self, properties: dict, properties_negated: dict | None = None, entity_type: str | None = None) -> int:
    """
    Delete entities (and their relations) that match the given property filters.
    Uses DETACH DELETE to remove all relations as well.

    :param properties: Dictionary of properties to match using = operator (e.g., {"name": "test"})
    :param properties_negated: Dictionary of properties to match using <> operator (e.g., {"_ontology_version_id": "v1"})
    :param entity_type: Optional filter by entity type
    :return: Number of entities deleted
    """
    raise NotImplementedError("Subclasses must implement this method.")

  @abstractmethod
  async def raw_query(self, query: str, readonly=False, max_results=10000) -> dict:
    """
    Does a raw query to graph database

    :param query: The raw query string to execute
    :param readonly: If True, execute query in read-only mode
    :param max_results: Maximum number of results to return
    :return: Dictionary containing query results
    """
    raise NotImplementedError("Subclasses must implement this method.")

  @abstractmethod
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
    raise NotImplementedError("Subclasses must implement this method.")

  @abstractmethod
  async def get_graph_stats(self, datasource_ids: List[str] | None = None) -> dict:
    """
    Get statistics about the graph database.

    :return: Dictionary containing:
        - node_count: Total number of nodes
        - relation_count: Total number of relations
    """
    raise NotImplementedError("Subclasses must implement this method.")

  @abstractmethod
  async def fetch_random_entities(
    self,
    count: int = 10,
    entity_type: str | None = None,
    datasource_ids: List[str] | None = None,
  ) -> List[StructuredEntity]:
    """
    Fetch random entities from the graph database.

    :param count: Number of random entities to fetch
    :param entity_type: Optional filter by entity type
    :param datasource_ids: Optional allowed datasource ids; an empty list returns no entities
    :return: List of random entities
    """
    raise NotImplementedError("Subclasses must implement this method.")
