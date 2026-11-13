import hashlib
import json
import time
from typing import List, Optional
from common import utils
from common import constants
from common.models.ontology import (
  PropertyMapping,
  PropertyMappingStructure,
  PropertyMappingRule,
  ExampleStructuredEntityMatch,
  FkeyEvaluation,
  FkeyHeuristic,
  RelationCandidate,
  FkeyEvaluationResult,
  FkeyDirectionality,
)
from common.models.rag import StructuredEntity
from common.models.graph import Relation
from common.graph_db.base import GraphDB
from common.mongo_storage import MongoStorage
from agent_ontology.heuristics import DeepPropertyMatch


class RelationCandidateManager:
  """
  Manages relation candidates between entities.
  - Ontology DB: Stores relation structure and evaluation
  - MongoDB: Stores heuristic data (counts, examples)
  """

  def __init__(self, graph_db: GraphDB, ontology_graph_db: GraphDB, ontology_version_id: str, client_name: str, redis_client: MongoStorage, heuristics_key_prefix: str = constants.REDIS_GRAPH_RELATION_HEURISTICS_PREFIX):
    self.data_graph_db = graph_db
    self.ontology_graph_db = ontology_graph_db
    self.logger = utils.get_logger("rc_manager")
    self.max_relation_examples = 10
    self.ontology_version_id = ontology_version_id
    self.client_name = client_name

    # Heuristics storage
    self.redis_client = redis_client
    self.heuristics_key_prefix = heuristics_key_prefix

  # =========================================================================
  # Core Public API
  # =========================================================================

  def generate_relation_id(self, entity_type: str, matched_entity_type: str, property_mappings: List[PropertyMapping]) -> str:
    """
    Generates a unique relation ID for the given entity types and property mappings.
    """
    props_dict = {}
    for prop in property_mappings:
      props_dict[prop.entity_a_property] = prop.entity_b_idkey_property
    rc_dict = {"entity_type": entity_type, "matched_entity_type": matched_entity_type, "property_mappings": props_dict}
    prop_json = json.dumps(rc_dict, sort_keys=True, cls=utils.ObjEncoder)
    prop_md5 = hashlib.md5(prop_json.encode())
    relation_id = prop_md5.hexdigest()
    return relation_id

  async def fetch_sub_entities_recursive(self, entity_type: str, max_depth: int = 10) -> List[str]:
    """
    Recursively fetch all sub-entity types for a given entity type from ontology DB.
    Uses explore_neighborhood with depth 1 repeatedly until no more sub-entities found.

    Args:
        entity_type: The entity type to fetch sub-entities for
        max_depth: Maximum recursion depth (default 10)

    Returns:
        Flat list of all sub-entity type names
    """
    self.logger.debug(f"Fetching sub-entities for {entity_type}, max_depth={max_depth}")

    # Track visited types to avoid cycles
    visited_types = set()
    sub_entity_types = []

    async def fetch_recursive(current_type: str, current_depth: int):
      """Helper function to recursively fetch sub-entities"""
      if current_depth >= max_depth:
        return

      if current_type in visited_types:
        return

      visited_types.add(current_type)

      # Compute PK for current type
      current_pk = f"{current_type}{constants.PROP_DELIMITER}{self.ontology_version_id}"

      try:
        # Fetch neighborhood with depth 1
        result = await self.ontology_graph_db.explore_neighborhood(entity_type=current_type, entity_pk=current_pk, depth=1, max_results=1000)

        # Filter for sub-entity relations (HAS relations from parent to sub)
        for relation in result.get("relations", []):
          if relation.relation_name == constants.DEFAULT_SUB_ENTITY_RELATION_NAME:
            # Get the target entity type (sub-entity)
            sub_entity_type = relation.to_entity.entity_type

            if sub_entity_type not in visited_types:
              sub_entity_types.append(sub_entity_type)
              # Recursively fetch sub-entities of this sub-entity
              await fetch_recursive(sub_entity_type, current_depth + 1)

      except Exception as e:
        self.logger.warning(f"Error fetching sub-entities for {current_type}: {e}")

    # Start recursive fetch
    await fetch_recursive(entity_type, 0)

    self.logger.debug(f"Found {len(sub_entity_types)} sub-entities for {entity_type}: {sub_entity_types}")
    return sub_entity_types

  async def update_heuristics_batch(self, updates: List["DeepPropertyMatch"]):
    """
    Takes a list of DeepPropertyMatch objects and batch updates heuristics in MongoDB as FkeyHeuristic.
    Also ensures relation candidates exist in Ontology DB and updates the ontology graph.

    Note: Schema entity nodes should already exist in Ontology DB (created by heuristics.py).
    """
    if not updates:
      self.logger.warning("No updates to batch update heuristics")
      return

    self.logger.info(f"Batch updating {len(updates)} heuristics")
    unique_relations = {}
    for dm in updates:
      if dm.relation_id and dm.relation_id not in unique_relations:
        unique_relations[dm.relation_id] = {"entity_a_type": dm.search_entity_type, "entity_b_type": dm.matched_entity_type, "property_mappings": dm.matching_properties}

    # Build all relations for batch update to the ontology graph db
    # Note: We don't create entity nodes here - they're pre-created by heuristics.py
    relations = []
    for relation_id, rel_data in unique_relations.items():
      # Create the relation identifiers (nodes should already exist)
      entity_a = StructuredEntity(
        entity_type=rel_data["entity_a_type"], primary_key_properties=[constants.ENTITY_TYPE_NAME_KEY, constants.ONTOLOGY_VERSION_ID_KEY], all_properties={constants.ENTITY_TYPE_NAME_KEY: rel_data["entity_a_type"], constants.ONTOLOGY_VERSION_ID_KEY: self.ontology_version_id}
      )
      entity_b = StructuredEntity(
        entity_type=rel_data["entity_b_type"], primary_key_properties=[constants.ENTITY_TYPE_NAME_KEY, constants.ONTOLOGY_VERSION_ID_KEY], all_properties={constants.ENTITY_TYPE_NAME_KEY: rel_data["entity_b_type"], constants.ONTOLOGY_VERSION_ID_KEY: self.ontology_version_id}
      )

      relation = Relation(
        from_entity=entity_a.get_identifier(),
        to_entity=entity_b.get_identifier(),
        relation_name=constants.CANDIDATE_RELATION_NAME,
        relation_pk=relation_id,
        relation_properties={
          constants.RELATION_PK_KEY: relation_id,
          constants.ONTOLOGY_RELATION_ID_KEY: relation_id,
          constants.ONTOLOGY_VERSION_ID_KEY: self.ontology_version_id,
          "property_mappings": json.dumps([pm.model_dump() for pm in rel_data["property_mappings"]]),
          "is_candidate": True,
          "created_at": int(time.time()),
        },
      )
      self.logger.debug(f"Creating relation {relation_id} pk={relation.relation_pk} [{relation.from_entity.entity_type} -> {relation.to_entity.entity_type}]")
      relations.append(relation)

    # Use batch update for all relations to the ontology graph db
    if relations:
      self.logger.info(f"Creating {len(relations)} relation candidates in Ontology DB")
      await self.ontology_graph_db.update_relation_batch(relations, batch_size=1000)
      self.logger.info(f"Successfully created {len(relations)} relation candidates in one batch")

    # Then batch update heuristics in MongoDB using pipeline
    self.logger.info(f"Batch updating {len(updates)} heuristics in MongoDB")
    pipe = self.redis_client.pipeline()

    for dm in updates:
      if not dm.relation_id:
        continue

      relation_id = dm.relation_id
      key = self._heuristic_key(relation_id)

      # Calculate quality metrics for this match
      avg_value_match_quality = sum(pm.value_match_quality for pm in dm.matching_properties) / len(dm.matching_properties)
      deep_match_quality = dm.deep_match_quality

      # Increment total matches
      pipe.hincrby(key, "total_matches", 1)

      # Update global quality sums (for backward compatibility and overall metrics)
      pipe.hincrbyfloat(key, "value_match_quality_sum", avg_value_match_quality)
      pipe.hincrbyfloat(key, "deep_match_quality_sum", deep_match_quality)

      # Increment per-property match patterns with quality tracking
      for pm in dm.matching_properties:
        prop_pair = f"{pm.entity_a_property}->{pm.entity_b_idkey_property}"

        # Store count
        pipe.hincrby(key, f"prop_pattern:{prop_pair}:{pm.match_type}:count", 1)

        # Store quality sum for this property and match type
        pipe.hincrbyfloat(key, f"prop_pattern:{prop_pair}:{pm.match_type}:quality_sum", pm.value_match_quality)

      # Add example
      examples_key = self._examples_key(relation_id)
      example = json.dumps({"a": dm.search_entity_pk, "b": dm.matched_entity_pk})
      pipe.rpush(examples_key, example)
      pipe.ltrim(examples_key, 0, self.max_relation_examples - 1)

      # Set metadata (structure only)
      property_mappings_structure = [{"entity_a_property": pm.entity_a_property, "entity_b_idkey_property": pm.entity_b_idkey_property} for pm in dm.matching_properties]

      metadata = {"entity_a_type": dm.search_entity_type, "entity_b_type": dm.matched_entity_type, "property_mappings": json.dumps(property_mappings_structure)}
      pipe.hset(key, mapping=metadata)  # type: ignore

    # Execute pipeline
    await pipe.execute()
    self.logger.info(f"Completed batch update of {len(updates)} heuristics")

  async def update_evaluations_batch(self, evaluations: List[dict]):
    """
    Batch update multiple evaluations.

    Args:
        evaluations: List of dicts with keys:
            - relation_id: str
            - entity_a_type: str
            - entity_b_type: str
            - relation_name: str
            - result: FkeyEvaluationResult
            - justification: str
            - thought: str
            - directionality: FkeyDirectionality
            - is_manual: bool
            - is_sub_entity_relation: bool
            - property_mappings: List[PropertyMappingRule]
    """
    if not evaluations:
      return

    self.logger.info(f"Batch updating {len(evaluations)} evaluations")

    # Process each evaluation
    for eval_data in evaluations:
      evaluation = FkeyEvaluation(
        relation_name=eval_data["relation_name"],
        result=eval_data["result"],
        justification=eval_data.get("justification", ""),
        thought=eval_data.get("thought", ""),
        last_evaluated=int(time.time()),
        is_manual=eval_data.get("is_manual", False),
        is_sub_entity_relation=eval_data.get("is_sub_entity_relation", False),
        directionality=eval_data.get("directionality", FkeyDirectionality.FROM_A_TO_B),
        property_mappings=eval_data["property_mappings"],
      )

      # Store evaluation in Ontology DB
      await self._store_evaluation(eval_data["relation_id"], eval_data["entity_a_type"], eval_data["entity_b_type"], evaluation)

    self.logger.info(f"Completed batch update of {len(evaluations)} evaluations")

  async def update_evaluation(
    self, relation_id: str, relation_name: str, result: FkeyEvaluationResult, justification: str | None, thought: str, is_manual: bool, property_mappings: List[PropertyMappingRule], is_sub_entity_relation: bool = False, directionality: FkeyDirectionality = FkeyDirectionality.FROM_A_TO_B
  ):
    """
    Update evaluation for a relation (stored in Ontology DB).

    Args:
        relation_id: The relation ID
        relation_name: Name of the relation
        result: Evaluation result (ACCEPTED/REJECTED/UNSURE)
        justification: Justification for the evaluation
        thought: Agent's thought process
        is_manual: Whether evaluation was manual
        property_mappings: Property mapping rules (which properties + match strategies)
        is_sub_entity_relation: Whether this is a sub-entity relation
        directionality: Direction of the relation
    """
    self.logger.debug(f"Updating evaluation for relation_id={relation_id}")

    if not relation_name:
      raise ValueError(f"Cannot update evaluation for relation {relation_id} without a relation name")

    # Fetch current candidate to get entity types
    candidate = await self.fetch_candidate(relation_id)
    if not candidate:
      self.logger.warning(f"Relation {relation_id} not found, cannot update evaluation")
      return

    # Create evaluation
    evaluation = FkeyEvaluation(
      relation_name=relation_name,
      result=result,
      justification=justification,
      thought=thought,
      last_evaluated=int(time.time()),
      is_manual=is_manual,
      is_sub_entity_relation=is_sub_entity_relation,
      directionality=directionality,
      property_mappings=property_mappings,
    )

    # Store evaluation in Ontology DB
    await self._store_evaluation(relation_id, candidate.heuristic.entity_a_type, candidate.heuristic.entity_b_type, evaluation)

  async def fetch_candidate(self, relation_id: str) -> Optional[RelationCandidate]:
    """
    Fetch a complete relation candidate (merges data from Ontology DB and MongoDB).

    Returns:
        RelationCandidate with both heuristic and evaluation data, or None
    """
    self.logger.debug(f"Fetching candidate for relation_id={relation_id}")

    # Fetch heuristic from MongoDB
    heuristic = await self.fetch_heuristic(relation_id)

    if not heuristic:
      self.logger.warning(f"Heuristic not found for relation {relation_id}, cannot fetch candidate")
      return None

    # Fetch evaluation AND sync status from Ontology DB in one query
    evaluation, sync_status = await self._fetch_evaluation_and_sync_status(relation_id)

    return RelationCandidate(relation_id=relation_id, heuristic=heuristic, evaluation=evaluation, is_synced=sync_status.get("is_synced", False), last_synced=sync_status.get("last_synced", 0), error_message=sync_status.get("error_message", ""))

  async def fetch_all_candidates(self) -> dict[str, RelationCandidate]:
    """
    Fetch all relation candidates (merges data from Ontology DB and MongoDB).

    Returns:
        Dictionary mapping relation_id to RelationCandidate
    """
    self.logger.debug("Fetching all relation candidates")

    # Get all relation IDs from Ontology DB
    relations = await self.ontology_graph_db.find_relations(properties={constants.ONTOLOGY_VERSION_ID_KEY: self.ontology_version_id})

    candidates = {}
    for relation in relations:
      if not relation.relation_properties:
        continue
      relation_id = relation.relation_properties.get(constants.ONTOLOGY_RELATION_ID_KEY)
      if not relation_id:
        continue

      candidate = await self.fetch_candidate(relation_id)
      if candidate:
        candidates[relation_id] = candidate

    return candidates

  async def sync_relation(self, relation_id: str):
    """
    Sync relation to data graph based on evaluation.
    - ACCEPTED: Apply relation
    - REJECTED/UNSURE: Remove relation
    """
    self.logger.info(f"Syncing relation {relation_id}")

    candidate = await self.fetch_candidate(relation_id)
    if not candidate or not candidate.evaluation:
      await self._unapply_relation(relation_id)
      await self._update_sync_status(relation_id, is_synced=True, error_message="")
      return

    try:
      if candidate.evaluation.result == FkeyEvaluationResult.ACCEPTED:
        await self._apply_relation(relation_id, candidate.evaluation.relation_name, candidate.evaluation.property_mappings, candidate.heuristic.entity_a_type, candidate.heuristic.entity_b_type, candidate.evaluation.directionality)
      else:
        await self._unapply_relation(relation_id)

      # Mark as synced successfully
      await self._update_sync_status(relation_id, is_synced=True, error_message="")

    except Exception as e:
      self.logger.error(f"Error syncing relation {relation_id}: {e}", exc_info=True)
      # Mark as not synced with error message
      await self._update_sync_status(relation_id, is_synced=False, error_message=str(e))

  async def remove_evaluation(self, relation_id: str):
    """Remove evaluation for a relation (keeps heuristic data)."""
    self.logger.info(f"Removing evaluation for relation {relation_id}")
    await self._delete_evaluation(relation_id)

  async def delete_candidate(self, relation_id: str):
    """
    Delete a relation candidate completely (from both Redis and Graph DB).
    This removes:
    - Heuristic data from MongoDB
    - Relation structure/evaluation from Ontology DB
    - Applied relation from Data graph (if exists)
    """
    self.logger.debug(f"Deleting relation candidate {relation_id}")

    # Delete from MongoDB (heuristics)
    heuristic_key = self._heuristic_key(relation_id)
    examples_key = self._examples_key(relation_id)
    # Delete both keys
    await self.redis_client.delete(heuristic_key)
    await self.redis_client.delete(examples_key)

    self.logger.debug(f"Deleted Redis keys for relation {relation_id}")

    # Delete from Ontology DB (relation structure/evaluation)
    await self.ontology_graph_db.remove_relation(None, properties={constants.ONTOLOGY_RELATION_ID_KEY: relation_id, constants.ONTOLOGY_VERSION_ID_KEY: self.ontology_version_id})
    self.logger.debug(f"Deleted ontology DB relation for {relation_id}")

    # Delete from Data graph (if applied)
    await self._unapply_relation(relation_id)
    self.logger.debug(f"Deleted data graph relation for {relation_id}")

  async def cleanup(self):
    """Clean up old relations and heuristics from previous ontology versions."""
    self.logger.info("Cleaning up old relations and heuristics")

    # Delete old relations from ontology graph (where version does NOT match current)
    deleted_rels = await self.ontology_graph_db.delete_relations_by_properties(properties={}, properties_negated={constants.ONTOLOGY_VERSION_ID_KEY: self.ontology_version_id})
    self.logger.debug(f"Deleted {deleted_rels} old relations from ontology graph")

    # Delete old nodes from ontology graph (where version does NOT match current)
    deleted_nodes = await self.ontology_graph_db.delete_entities_by_properties(properties={}, properties_negated={constants.ONTOLOGY_VERSION_ID_KEY: self.ontology_version_id})
    self.logger.debug(f"Deleted {deleted_nodes} old nodes from ontology graph")

    # Delete old relations from data graph (only those updated by this client and where version does NOT match)
    deleted_data_rels = await self.data_graph_db.delete_relations_by_properties(properties={constants.RELATION_UPDATED_BY_KEY: self.client_name}, properties_negated={constants.ONTOLOGY_VERSION_ID_KEY: self.ontology_version_id})
    self.logger.debug(f"Deleted {deleted_data_rels} old relations from data graph")

    # Delete old heuristics from MongoDB (where version does NOT match current)
    # Scan for all keys with the heuristics prefix
    deleted_heuristics_count = 0
    cursor = 0
    pattern = f"{self.heuristics_key_prefix}*"

    while True:
      cursor, keys = await self.redis_client.scan(cursor, match=pattern, count=100)  # type: ignore

      for key in keys:
        # Decode key if bytes
        key_str = key.decode() if isinstance(key, bytes) else key

        # Check if this key belongs to a different ontology version
        # Format: {prefix}{version}:rel:{relation_id} or {prefix}{version}:rel:{relation_id}:ex
        # Extract version from key
        if key_str.startswith(self.heuristics_key_prefix):
          # Remove prefix to get version:rel:...
          remainder = key_str[len(self.heuristics_key_prefix) :]

          # Extract version (everything before :rel:)
          if ":rel:" in remainder:
            version = remainder.split(":rel:", 1)[0]

            # Delete if version doesn't match current
            if version != self.ontology_version_id:
              await self.redis_client.delete(key)
              deleted_heuristics_count += 1

      # Break if scan is complete
      if cursor == 0:
        break

    self.logger.info(f"Deleted {deleted_heuristics_count} old heuristic keys from MongoDB")

  # =========================================================================
  # Heuristic Storage (MongoDB) - Internal
  # =========================================================================

  def _heuristic_key(self, relation_id: str) -> str:
    """Get Redis key for heuristic metadata (scoped to ontology version)."""
    return f"{self.heuristics_key_prefix}{self.ontology_version_id}:rel:{relation_id}"

  def _examples_key(self, relation_id: str) -> str:
    """Get Redis key for examples list (scoped to ontology version)."""
    return f"{self.heuristics_key_prefix}{self.ontology_version_id}:rel:{relation_id}:ex"

  async def _increment_count(self, relation_id: str, amount: int = 1) -> int:
    """Atomically increment total_matches count (Redis HINCRBY)."""
    key = self._heuristic_key(relation_id)
    return int(await self.redis_client.hincrby(key, "total_matches", amount))  # type: ignore

  async def _add_example(self, relation_id: str, entity_a_pk: str, entity_b_pk: str) -> int:
    """Atomically add example (Redis RPUSH + LTRIM)."""

    key = self._examples_key(relation_id)
    example = json.dumps({"a": entity_a_pk, "b": entity_b_pk})

    await self.redis_client.rpush(key, example)  # type: ignore
    await self.redis_client.ltrim(key, 0, self.max_relation_examples - 1)  # type: ignore

    return int(await self.redis_client.llen(key))  # type: ignore

  async def _set_metadata(self, relation_id: str, entity_a_type: str, entity_b_type: str, entity_a_property: str, property_mappings: List[PropertyMapping], matching_entity_idkey: List[str]):
    """Set heuristic metadata (Redis HMSET)."""

    key = self._heuristic_key(relation_id)
    metadata = {"entity_a_type": entity_a_type, "entity_b_type": entity_b_type, "entity_a_property": entity_a_property, "property_mappings": json.dumps([pm.model_dump() for pm in property_mappings]), "matching_entity_idkey": json.dumps(matching_entity_idkey), "last_updated": str(int(time.time()))}
    await self.redis_client.hmset(key, metadata)  # type: ignore

  async def fetch_heuristic(self, relation_id: str) -> Optional[FkeyHeuristic]:
    """Fetch heuristic data from MongoDB."""
    self.logger.debug(f"Fetching heuristic for relation {relation_id}")

    # Pipeline for single round-trip
    pipeline = self.redis_client.pipeline()
    pipeline.hgetall(self._heuristic_key(relation_id))
    pipeline.lrange(self._examples_key(relation_id), 0, -1)
    results = await pipeline.execute()

    metadata = results[0]
    examples_raw = results[1]

    if not metadata:
      self.logger.debug(f"No metadata found for relation {relation_id}, cannot fetch heuristic")
      return None

    # Parse metadata
    def get_str(d, key):
      val = d.get(key.encode() if isinstance(list(d.keys())[0], bytes) else key)
      return val.decode() if isinstance(val, bytes) else (val or "")

    def get_int(d, key):
      val = get_str(d, key)
      return int(val) if val else 0

    def get_float(d, key):
      val = get_str(d, key)
      return float(val) if val else 0.0

    self.logger.debug(f"Metadata: {metadata}")

    entity_a_type = get_str(metadata, "entity_a_type")
    entity_b_type = get_str(metadata, "entity_b_type")
    total_matches = get_int(metadata, "total_matches")

    property_mappings_json = get_str(metadata, "property_mappings")
    property_mappings = [PropertyMappingStructure(**pm) for pm in json.loads(property_mappings_json or "[]")]

    # Parse quality metrics (support both old and new field names)
    value_match_quality_sum = get_float(metadata, "value_match_quality_sum") or get_float(metadata, "quality_sum")
    deep_match_quality_sum = get_float(metadata, "deep_match_quality_sum")

    # Parse per-property match patterns with quality tracking
    property_match_patterns = {}
    property_match_quality_sums = {}  # Temporary for calculating averages

    for key in metadata.keys():
      key_str = key.decode() if isinstance(key, bytes) else key

      # Parse per-property match patterns (prop_pattern:a->b:exact:count)
      if key_str.startswith("prop_pattern:"):
        parts = key_str.replace("prop_pattern:", "").rsplit(":", 2)

        if len(parts) == 3:
          prop_pair, match_type, metric = parts

          if metric == "count":
            # Store count in property_match_patterns
            if prop_pair not in property_match_patterns:
              property_match_patterns[prop_pair] = {}
            property_match_patterns[prop_pair][match_type] = get_int(metadata, key_str)

          elif metric == "quality_sum":
            # Store quality sum for calculating average
            if prop_pair not in property_match_quality_sums:
              property_match_quality_sums[prop_pair] = {}
            property_match_quality_sums[prop_pair][match_type] = get_float(metadata, key_str)

        # Backward compatibility: handle old format without :count suffix
        elif len(parts) == 2:
          prop_pair, match_type = parts
          if prop_pair not in property_match_patterns:
            property_match_patterns[prop_pair] = {}
          property_match_patterns[prop_pair][match_type] = get_int(metadata, key_str)

    # Calculate per-property per-match-type quality averages
    property_match_quality = {}
    for prop_pair in property_match_patterns.keys():
      if prop_pair not in property_match_quality:
        property_match_quality[prop_pair] = {}

      for match_type, count in property_match_patterns[prop_pair].items():
        quality_sum = property_match_quality_sums.get(prop_pair, {}).get(match_type, 0.0)
        avg_quality = quality_sum / count if count > 0 else 0.0
        property_match_quality[prop_pair][match_type] = avg_quality

    # Calculate derived averages
    value_match_quality_avg = value_match_quality_sum / total_matches if total_matches > 0 else 0.0
    deep_match_quality_avg = deep_match_quality_sum / total_matches if total_matches > 0 else 0.0

    # Parse examples
    example_matches = []
    for ex_raw in examples_raw:
      ex_str = ex_raw.decode() if isinstance(ex_raw, bytes) else ex_raw
      ex_data = json.loads(ex_str)
      example_matches.append(ExampleStructuredEntityMatch(entity_a_pk=ex_data["a"], entity_b_pk=ex_data["b"]))

    return FkeyHeuristic(
      entity_a_type=entity_a_type,
      entity_b_type=entity_b_type,
      property_mappings=property_mappings,
      total_matches=total_matches,
      example_matches=example_matches,
      property_match_patterns=property_match_patterns,
      property_match_quality=property_match_quality,
      value_match_quality_avg=value_match_quality_avg,
      deep_match_quality_avg=deep_match_quality_avg,
      value_match_quality_sum=value_match_quality_sum,
      deep_match_quality_sum=deep_match_quality_sum,
      last_processed=get_int(metadata, "last_updated"),
    )

  async def fetch_heuristics_batch(self, relation_ids: List[str]) -> dict[str, Optional[FkeyHeuristic]]:
    """
    Fetch heuristics for multiple relations in a single batch using ordered MongoDB operations.

    Args:
        relation_ids: List of relation IDs to fetch heuristics for

    Returns:
        Dictionary mapping relation_id to FkeyHeuristic (or None if not found)
    """
    if not relation_ids:
      return {}

    self.logger.debug(f"Fetching heuristics for {len(relation_ids)} relations in batch")

    # Build pipeline to fetch all heuristics and examples at once
    pipeline = self.redis_client.pipeline()
    for relation_id in relation_ids:
      pipeline.hgetall(self._heuristic_key(relation_id))
      pipeline.lrange(self._examples_key(relation_id), 0, -1)

    # Execute pipeline
    results = await pipeline.execute()

    # Parse results
    heuristics_dict = {}
    for i, relation_id in enumerate(relation_ids):
      metadata_idx = i * 2
      examples_idx = i * 2 + 1

      metadata = results[metadata_idx]
      examples_raw = results[examples_idx]

      if not metadata:
        self.logger.debug(f"No metadata found for relation {relation_id}")
        heuristics_dict[relation_id] = None
        continue

      # Parse metadata
      def get_str(d, key):
        val = d.get(key.encode() if isinstance(list(d.keys())[0], bytes) else key)
        return val.decode() if isinstance(val, bytes) else (val or "")

      def get_int(d, key):
        val = get_str(d, key)
        return int(val) if val else 0

      def get_float(d, key):
        val = get_str(d, key)
        return float(val) if val else 0.0

      entity_a_type = get_str(metadata, "entity_a_type")
      entity_b_type = get_str(metadata, "entity_b_type")
      total_matches = get_int(metadata, "total_matches")

      property_mappings_json = get_str(metadata, "property_mappings")
      property_mappings = [PropertyMappingStructure(**pm) for pm in json.loads(property_mappings_json or "[]")]

      # Parse quality metrics
      value_match_quality_sum = get_float(metadata, "value_match_quality_sum") or get_float(metadata, "quality_sum")
      deep_match_quality_sum = get_float(metadata, "deep_match_quality_sum")

      # Parse per-property match patterns with quality tracking
      property_match_patterns = {}
      property_match_quality_sums = {}  # Temporary for calculating averages

      for key in metadata.keys():
        key_str = key.decode() if isinstance(key, bytes) else key

        # Parse per-property match patterns (prop_pattern:a->b:exact:count)
        if key_str.startswith("prop_pattern:"):
          parts = key_str.replace("prop_pattern:", "").rsplit(":", 2)

          if len(parts) == 3:
            prop_pair, match_type, metric = parts

            if metric == "count":
              # Store count in property_match_patterns
              if prop_pair not in property_match_patterns:
                property_match_patterns[prop_pair] = {}
              property_match_patterns[prop_pair][match_type] = get_int(metadata, key_str)

            elif metric == "quality_sum":
              # Store quality sum for calculating average
              if prop_pair not in property_match_quality_sums:
                property_match_quality_sums[prop_pair] = {}
              property_match_quality_sums[prop_pair][match_type] = get_float(metadata, key_str)

          # Backward compatibility: handle old format without :count suffix
          elif len(parts) == 2:
            prop_pair, match_type = parts
            if prop_pair not in property_match_patterns:
              property_match_patterns[prop_pair] = {}
            property_match_patterns[prop_pair][match_type] = get_int(metadata, key_str)

      # Calculate per-property per-match-type quality averages
      property_match_quality = {}
      for prop_pair in property_match_patterns.keys():
        if prop_pair not in property_match_quality:
          property_match_quality[prop_pair] = {}

        for match_type, count in property_match_patterns[prop_pair].items():
          quality_sum = property_match_quality_sums.get(prop_pair, {}).get(match_type, 0.0)
          avg_quality = quality_sum / count if count > 0 else 0.0
          property_match_quality[prop_pair][match_type] = avg_quality

      # Calculate derived averages
      value_match_quality_avg = value_match_quality_sum / total_matches if total_matches > 0 else 0.0
      deep_match_quality_avg = deep_match_quality_sum / total_matches if total_matches > 0 else 0.0

      # Parse examples
      example_matches = []
      for ex_raw in examples_raw:
        ex_str = ex_raw.decode() if isinstance(ex_raw, bytes) else ex_raw
        ex_data = json.loads(ex_str)
        example_matches.append(ExampleStructuredEntityMatch(entity_a_pk=ex_data["a"], entity_b_pk=ex_data["b"]))

      heuristics_dict[relation_id] = FkeyHeuristic(
        entity_a_type=entity_a_type,
        entity_b_type=entity_b_type,
        property_mappings=property_mappings,
        total_matches=total_matches,
        example_matches=example_matches,
        property_match_patterns=property_match_patterns,
        property_match_quality=property_match_quality,
        value_match_quality_avg=value_match_quality_avg,
        deep_match_quality_avg=deep_match_quality_avg,
        value_match_quality_sum=value_match_quality_sum,
        deep_match_quality_sum=deep_match_quality_sum,
        last_processed=get_int(metadata, "last_updated"),
      )

    self.logger.info(f"Fetched {len([h for h in heuristics_dict.values() if h is not None])} heuristics out of {len(relation_ids)} requested")
    return heuristics_dict

  # =========================================================================
  # Relation Structure & Evaluation (Ontology DB) - Internal
  # =========================================================================

  async def _store_evaluation(self, relation_id: str, entity_a_type: str, entity_b_type: str, evaluation: FkeyEvaluation):
    """Store evaluation in Ontology DB as a relation."""
    # Note: StructuredEntity types should already exist in ontology DB from the ontology_cache.flush().
    # We don't need to ensure entities exist here to avoid single-entity batch updates.

    # Remove old relation if exists (to handle directionality changes)
    await self.ontology_graph_db.remove_relation(None, properties={constants.ONTOLOGY_RELATION_ID_KEY: relation_id, constants.ONTOLOGY_VERSION_ID_KEY: self.ontology_version_id})

    # Note: Sub-entity labels are handled by the ontology_cache.flush() in heuristics.py
    # which batches all entity type updates together. We don't need to update it here.

    # Fetch existing sync status to preserve it when updating evaluation
    _, sync_status = await self._fetch_evaluation_and_sync_status(relation_id)

    # Build relation properties
    props = {
      constants.RELATION_PK_KEY: relation_id,
      constants.ONTOLOGY_RELATION_ID_KEY: relation_id,
      constants.ONTOLOGY_VERSION_ID_KEY: self.ontology_version_id,
      "eval_relation_name": evaluation.relation_name,
      "eval_result": evaluation.result.value,
      "eval_justification": evaluation.justification or "",
      "eval_thought": evaluation.thought,
      "eval_last_evaluated": evaluation.last_evaluated,
      "eval_is_manual": evaluation.is_manual,
      "eval_is_sub_entity": evaluation.is_sub_entity_relation,
      "eval_directionality": evaluation.directionality.value,
      "eval_property_mappings": json.dumps([pm.model_dump() for pm in evaluation.property_mappings]),
      # Preserve sync status
      "sync_is_synced": sync_status.get("is_synced", False),
      "sync_last_synced": sync_status.get("last_synced", 0),
      "sync_error_message": sync_status.get("error_message", ""),
    }

    # Create relation based on directionality
    entity_a = StructuredEntity(entity_type=entity_a_type, primary_key_properties=[constants.ENTITY_TYPE_NAME_KEY, constants.ONTOLOGY_VERSION_ID_KEY], all_properties={constants.ENTITY_TYPE_NAME_KEY: entity_a_type, constants.ONTOLOGY_VERSION_ID_KEY: self.ontology_version_id})
    entity_b = StructuredEntity(entity_type=entity_b_type, primary_key_properties=[constants.ENTITY_TYPE_NAME_KEY, constants.ONTOLOGY_VERSION_ID_KEY], all_properties={constants.ENTITY_TYPE_NAME_KEY: entity_b_type, constants.ONTOLOGY_VERSION_ID_KEY: self.ontology_version_id})

    if evaluation.directionality == FkeyDirectionality.FROM_A_TO_B:
      from_entity, to_entity = entity_a, entity_b
    else:
      from_entity, to_entity = entity_b, entity_a

    relation = Relation(from_entity=from_entity.get_identifier(), to_entity=to_entity.get_identifier(), relation_name=evaluation.relation_name, relation_pk=relation_id, relation_properties=props)

    await self.ontology_graph_db.update_relation(relation)

  async def fetch_evaluation(self, relation_id: str) -> Optional[FkeyEvaluation]:
    """
    Fetch evaluation from Ontology DB.
    Note: For better performance, use _fetch_evaluation_and_sync_status() to get both at once.
    """
    evaluation, _ = await self._fetch_evaluation_and_sync_status(relation_id)
    return evaluation

  async def fetch_evaluations_and_sync_status_batch(self, relation_ids: List[str]) -> dict[str, dict]:
    """
    Fetch evaluations AND sync status for multiple relations in a batch.

    Args:
        relation_ids: List of relation IDs to fetch

    Returns:
        Dictionary mapping relation_id to dict with keys:
            - evaluation: FkeyEvaluation or None
            - sync_status: dict with is_synced, last_synced, error_message
    """
    if not relation_ids:
      return {}

    self.logger.debug(f"Fetching evaluations and sync status for {len(relation_ids)} relations in batch")

    # Fetch all relations at once using find_relations with OR conditions
    # Since we need multiple relation_ids, we'll do individual queries but in parallel
    # Note: Neo4j doesn't support OR on properties easily, so we batch by querying in parallel

    import asyncio

    # Create tasks for parallel fetching
    tasks = [self._fetch_evaluation_and_sync_status(relation_id) for relation_id in relation_ids]

    # Execute all tasks in parallel
    results = await asyncio.gather(*tasks, return_exceptions=True)

    # Build result dictionary
    result_dict = {}
    for relation_id, result in zip(relation_ids, results):
      if isinstance(result, Exception):
        self.logger.error(f"Error fetching evaluation/sync_status for {relation_id}: {result}")
        result_dict[relation_id] = {"evaluation": None, "sync_status": {"is_synced": False, "last_synced": 0, "error_message": str(result)}}
      else:
        evaluation, sync_status = result
        result_dict[relation_id] = {"evaluation": evaluation.model_dump(mode="json") if evaluation else None, "sync_status": sync_status}

    self.logger.info(f"Fetched evaluations and sync status for {len(result_dict)} relations")
    return result_dict

  async def _fetch_evaluation_and_sync_status(self, relation_id: str) -> tuple[Optional[FkeyEvaluation], dict]:
    """
    Fetch evaluation AND sync status from Ontology DB in a single query (performance optimization).

    Returns:
        Tuple of (evaluation, sync_status_dict)
    """
    relations = await self.ontology_graph_db.find_relations(properties={constants.ONTOLOGY_RELATION_ID_KEY: relation_id, constants.ONTOLOGY_VERSION_ID_KEY: self.ontology_version_id})

    if not relations or not relations[0].relation_properties:
      return None, {"is_synced": False, "last_synced": 0, "error_message": ""}

    props = relations[0].relation_properties

    # Parse evaluation
    evaluation = None
    if props.get("eval_last_evaluated"):
      evaluation = FkeyEvaluation(
        relation_name=props.get("eval_relation_name") or "",
        result=FkeyEvaluationResult(props.get("eval_result") or FkeyEvaluationResult.UNSURE.value),
        justification=props.get("eval_justification") or "",
        thought=props.get("eval_thought") or "",
        last_evaluated=props.get("eval_last_evaluated") or 0,
        is_manual=props.get("eval_is_manual") or False,
        is_sub_entity_relation=props.get("eval_is_sub_entity") or False,
        directionality=FkeyDirectionality(props.get("eval_directionality") or FkeyDirectionality.FROM_A_TO_B.value),
        property_mappings=[PropertyMappingRule(**pm) for pm in json.loads(props.get("eval_property_mappings") or "[]")],
      )

    # Parse sync status
    sync_status = {"is_synced": props.get("sync_is_synced", False), "last_synced": props.get("sync_last_synced", 0), "error_message": props.get("sync_error_message", "")}

    return evaluation, sync_status

  async def _delete_evaluation(self, relation_id: str):
    """Delete evaluation from Ontology DB."""
    await self.ontology_graph_db.remove_relation(None, properties={constants.ONTOLOGY_RELATION_ID_KEY: relation_id, constants.ONTOLOGY_VERSION_ID_KEY: self.ontology_version_id})

  async def _update_sync_status(self, relation_id: str, is_synced: bool, error_message: str):
    """Update sync status in Ontology DB."""
    relations = await self.ontology_graph_db.find_relations(properties={constants.ONTOLOGY_RELATION_ID_KEY: relation_id, constants.ONTOLOGY_VERSION_ID_KEY: self.ontology_version_id})

    if not relations:
      self.logger.warning(f"Relation {relation_id} not found, cannot update sync status")
      return

    # Update the relation properties
    relation = relations[0]
    if not relation.relation_properties:
      relation.relation_properties = {}

    relation.relation_properties["sync_is_synced"] = is_synced
    relation.relation_properties["sync_last_synced"] = int(time.time())
    relation.relation_properties["sync_error_message"] = error_message

    # Update the relation in the database
    await self.ontology_graph_db.update_relation(relation)

  # =========================================================================
  # Data Graph Sync - Internal
  # =========================================================================

  async def _apply_relation(self, relation_id: str, relation_name: str, property_mappings: List[PropertyMappingRule], entity_a_type: str, entity_b_type: str, directionality: FkeyDirectionality):
    """
    Apply relation to data graph.

    Accepts any property mapping type since we only need the property names for matching.
    """
    self.logger.debug(f"Applying relation {relation_id}")

    # Remove old relation first
    await self._unapply_relation(relation_id)

    relation_properties = {constants.RELATION_PK_KEY: relation_id, constants.ONTOLOGY_RELATION_ID_KEY: relation_id, constants.ONTOLOGY_VERSION_ID_KEY: self.ontology_version_id, constants.RELATION_UPDATED_BY_KEY: self.client_name}

    if directionality == FkeyDirectionality.FROM_A_TO_B:
      # Convert List[PropertyMappingRule] to dict format for graph_db
      matching_properties_dict = {pm.entity_a_property: (pm.entity_b_idkey_property, pm.match_type) for pm in property_mappings}
      await self.data_graph_db.relate_entities_by_property(entity_a_type=entity_a_type, entity_b_type=entity_b_type, relation_type=relation_name, matching_properties=matching_properties_dict, relation_pk=relation_id, relation_properties=relation_properties)
    else:
      # Reverse the property mappings for FROM_B_TO_A and convert to dict
      matching_properties_dict = {pm.entity_b_idkey_property: (pm.entity_a_property, pm.match_type) for pm in property_mappings}
      await self.data_graph_db.relate_entities_by_property(entity_a_type=entity_b_type, entity_b_type=entity_a_type, relation_type=relation_name, matching_properties=matching_properties_dict, relation_pk=relation_id, relation_properties=relation_properties)

  async def _unapply_relation(self, relation_id: str):
    """Remove relation from data graph."""
    await self.data_graph_db.remove_relation(None, {constants.ONTOLOGY_RELATION_ID_KEY: relation_id})
