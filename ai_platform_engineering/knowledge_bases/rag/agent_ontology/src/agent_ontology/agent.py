import os
import traceback
import asyncio

from common.graph_db.base import GraphDB
from common import constants
from agent_ontology.heuristics import HeuristicsProcessor
from agent_ontology.relation_manager import RelationCandidateManager
from agent_ontology.prompts import SYSTEM_PROMPT_1
from agent_ontology.agent_worker import AgentWorker
from common.models.ontology import (
  FkeyDirectionality,
  RelationCandidate,
  FkeyEvaluationResult,
  ValueMatchType,
  PropertyMappingRule,
  RelationCandidateGroup,
  CandidateGroupData,
  EntityExample,
)
from langchain_core.messages import HumanMessage
import gc
from common.mongo_storage import MongoStorage
import common.utils as utils
from cnoe_agent_utils import LLMFactory
from langfuse import get_client as get_langfuse_client
from langfuse.langchain import CallbackHandler

langfuse_client = get_langfuse_client()


class OntologyAgent:
  """
  This class contains functions for evaluating and processing heuristics as well as the code that
   agent follows to determine relations.
  """

  def __init__(self, graph_db: GraphDB, ontology_graph_db: GraphDB, redis: MongoStorage, min_count_for_eval: int, count_change_threshold_ratio: float, max_concurrent_evaluation: int, agent_recursion_limit: int):
    """
    Initializes the OntologyAgent with the given parameters.
    Args:
        graph_db (GraphDB): The graph database to use.
        ontology_graph_db (GraphDB): The ontology graph database to use.
        min_count_for_eval (int): The minimum count of matches to consider the heuristic for evaluation.
        count_change_threshold_ratio (float): The ratio of count change needed to trigger re-evaluation (0.0-1.0, e.g., 0.1 = 10% change).
        max_concurrent_evaluation (int): The maximum number of concurrent evaluation tasks.
        agent_recursion_limit (int): The maximum number of recursive calls to the agent.
    """
    self.redis = redis
    self.data_graph_db = graph_db
    self.ontology_graph_db = ontology_graph_db
    self.logger = utils.get_logger("ontology_agent")
    self.evaluation_logger = utils.get_logger("ontology_agent_evaluation")
    self.min_count_for_eval = min_count_for_eval
    self.count_change_threshold_ratio = count_change_threshold_ratio
    self.max_concurrent_evaluation = max_concurrent_evaluation
    self.agent_recursion_limit = agent_recursion_limit
    self.agent_name = "OntologyAgent"
    self.last_evaluation_run_timestamp = 0

    # status flags
    self.is_processing = False  # Avoid parallel processing/evaluation
    self.is_evaluating = False

    self.agent_status_msg = "Idle"
    self.evaluation_count = 0  # Track number of evaluations made

    self.debug = os.getenv("DEBUG_AGENT", "false").lower() in ("true", "1", "yes")

  async def sync_all_relations(self, rc_manager: RelationCandidateManager):
    """
    Syncs all accepted relations with the graph database.
    """
    self.logger.info("Syncing all relations with the graph database...")
    candidates = await rc_manager.fetch_all_candidates()
    for idx, (relation_id, candidate) in enumerate(candidates.items(), 1):
      self.agent_status_msg = f"Syncing [{idx}/{len(candidates)}] relation {candidate.relation_id}"
      await rc_manager.sync_relation(candidate.relation_id)

  async def process_and_evaluate_all(self):
    self.logger.info("Running heuristics processing and the evaluation...")
    # self.last_evaluation_run_timestamp = time.time()

    # create a new ontology version
    new_ontology_version_id = utils.get_uuid()
    self.logger.info(f"Created new ontology version: {new_ontology_version_id}")

    # use the new ontology version for processing and evaluation
    rc_manager_new_version = RelationCandidateManager(self.data_graph_db, self.ontology_graph_db, new_ontology_version_id, self.agent_name, redis_client=self.redis, heuristics_key_prefix=constants.REDIS_GRAPH_RELATION_HEURISTICS_PREFIX)

    # fetch the current ontology version
    current_ontology_version_id = await self.redis.get(constants.KV_ONTOLOGY_VERSION_ID_KEY)
    rc_manager_current_version = None
    if current_ontology_version_id:
      rc_manager_current_version = RelationCandidateManager(self.data_graph_db, self.ontology_graph_db, current_ontology_version_id, self.agent_name, redis_client=self.redis, heuristics_key_prefix=constants.REDIS_GRAPH_RELATION_HEURISTICS_PREFIX)
      self.logger.info(f"Current ontology version: {current_ontology_version_id}, new version: {new_ontology_version_id}")
    else:
      self.logger.info("No current ontology version found, this seems to be the first run.")

    await self.process_all(rc_manager_new_version)
    if new_ontology_version_id is None:
      self.logger.error("Heuristics processing failed, skipping evaluation")
      return

    # Evaluate the new heuristics version
    self.agent_status_msg = "Evaluating relations..."
    await self.evaluate_all(rc_manager_current_version, rc_manager_new_version)

    # set the new ontology version as the current ontology version
    self.logger.info(f"Setting new ontology version: {new_ontology_version_id}")
    await self.redis.set(constants.KV_ONTOLOGY_VERSION_ID_KEY, new_ontology_version_id)

    self.agent_status_msg = "Syncing relations..."
    self.is_processing = True
    await self.sync_all_relations(rc_manager_new_version)  # sync all relations with the graph database, just in case some relations were not updated
    await rc_manager_new_version.cleanup()  # Clear all previous ontology

    self.agent_status_msg = "Idle"
    self.is_processing = False

    # invoke the garbage collector to free up memory
    gc.collect()

  async def process_all(self, rc_manager: RelationCandidateManager) -> str | None:
    """
    Processes all entities in the database to compute heuristics.
    This is meant to be run periodically to update the heuristics based on the entities in the database.
    """
    self.logger.info("Processing all entities for heuristics")
    if self.is_processing:
      self.logger.warning("Processing is already in progress, skipping this run")
      return None

    self.is_processing = True
    self.processing_tasks_total = 0
    self.processed_tasks_count = 0

    try:
      # Get total entity count for progress tracking
      total_entities = await self.data_graph_db.get_entity_count()
      self.processing_tasks_total = total_entities
      self.logger.info(f"Total entities to process: {total_entities}")

      # Create progress callback that logs messages
      async def progress_callback(message: str):
        self.agent_status_msg = message
        self.logger.info(message)

      # Create new efficient heuristics processor
      heuristics_processor = HeuristicsProcessor(
        graph_db=self.data_graph_db,
        rc_manager=rc_manager,
        entity_batch_size=10_000,
        index_batch_size=50_000,
        min_relation_count=3,  # Discard relations with count < 3 to reduce noise
        progress_callback=progress_callback,
      )

      # Process all entities efficiently with batching
      self.logger.info("Starting efficient heuristics processing with batching")
      await heuristics_processor.process_all_entities()

      self.logger.info(f"Heuristics processing complete. Stats: {heuristics_processor.stats}")

    except Exception as e:
      self.logger.error(traceback.format_exc())
      self.logger.error(f"Error during heuristics processing: {e}")
    finally:
      self.is_processing = False

  async def _group_and_filter_candidates(self, rc_manager_current: RelationCandidateManager | None, rc_manager_new: RelationCandidateManager) -> dict[tuple[str, str], tuple[list[RelationCandidate], list[str], str]]:
    """
    Group candidates by entity type pairs and filter by heuristic changes.
    Also auto-accepts sub-entity relations.

    Returns:
        Dictionary mapping (entity_a_type, entity_b_type) to tuple of:
        - list of candidates to evaluate
        - list of existing accepted relation names
        - reason for re-evaluation
    """
    self.evaluation_logger.info("Grouping and filtering candidates by entity type pairs")

    # Fetch current candidates if available
    current_candidates_by_id = {}
    if rc_manager_current:
      current_candidates_by_id = await rc_manager_current.fetch_all_candidates()

    # Fetch new candidates
    new_candidates = await rc_manager_new.fetch_all_candidates()
    self.evaluation_logger.info(f"Found {len(new_candidates)} total relation candidates")

    # Group by entity type pairs
    groups: dict[tuple[str, str], list[RelationCandidate]] = {}
    for candidate in new_candidates.values():
      key = (candidate.heuristic.entity_a_type, candidate.heuristic.entity_b_type)
      if key not in groups:
        groups[key] = []
      groups[key].append(candidate)

    self.evaluation_logger.info(f"Grouped into {len(groups)} entity type pairs")

    # Filter and annotate groups
    filtered_groups = {}

    for (entity_a_type, entity_b_type), candidates in groups.items():
      # Auto-accept sub-entity relations and skip them from evaluation
      filtered_candidates = []
      for candidate in candidates:
        if len(candidate.heuristic.property_mappings) == 1 and candidate.heuristic.property_mappings[0].entity_a_property == constants.PARENT_ENTITY_PK_KEY and candidate.heuristic.property_mappings[0].entity_b_idkey_property == constants.PRIMARY_ID_KEY:
          # Auto-accept sub-entity relation
          sub_entity_mapping = [PropertyMappingRule(entity_a_property=constants.PARENT_ENTITY_PK_KEY, entity_b_idkey_property=constants.PRIMARY_ID_KEY, match_type=ValueMatchType.EXACT)]
          await rc_manager_new.update_evaluation(
            relation_id=candidate.relation_id,
            relation_name=constants.DEFAULT_SUB_ENTITY_RELATION_NAME,
            result=FkeyEvaluationResult.ACCEPTED,
            justification="Auto-accepted sub-entity relation",
            thought="Automatically accepted sub-entity relation",
            is_manual=False,
            is_sub_entity_relation=True,
            directionality=FkeyDirectionality.FROM_B_TO_A,
            property_mappings=sub_entity_mapping,
          )
          self.evaluation_logger.info(f"Auto-accepted sub-entity relation {candidate.relation_id}")
          continue

        # Skip if count is below minimum
        if candidate.heuristic.total_matches < self.min_count_for_eval:
          default_mappings = [PropertyMappingRule(entity_a_property=pm.entity_a_property, entity_b_idkey_property=pm.entity_b_idkey_property, match_type=ValueMatchType.EXACT) for pm in candidate.heuristic.property_mappings]
          await rc_manager_new.update_evaluation(
            relation_id=candidate.relation_id,
            relation_name=constants.CANDIDATE_RELATION_NAME,
            justification=f"Count below minimum threshold for evaluation. ({candidate.heuristic.total_matches} < {self.min_count_for_eval})",
            thought="Automatically classed as unsure due to low count.",
            result=FkeyEvaluationResult.UNSURE,
            is_manual=False,
            property_mappings=default_mappings,
          )
          continue

        filtered_candidates.append(candidate)

      if not filtered_candidates:
        continue

      # Check if any candidate needs re-evaluation
      needs_evaluation = False
      change_reasons = []

      for candidate in filtered_candidates:
        current_candidate = current_candidates_by_id.get(candidate.relation_id)

        # If no current candidate or no evaluation, needs evaluation
        if not current_candidate or not current_candidate.evaluation:
          needs_evaluation = True
          change_reasons.append("New candidate")
          continue

        # Skip manual evaluations
        if current_candidate.evaluation.is_manual:
          self.logger.info(f"Skipping {candidate.relation_id} - manual evaluation")
          # Copy over the evaluation
          await rc_manager_new.update_evaluation(
            relation_id=candidate.relation_id,
            relation_name=current_candidate.evaluation.relation_name,
            justification=current_candidate.evaluation.justification,
            thought=current_candidate.evaluation.thought,
            result=current_candidate.evaluation.result,
            is_manual=current_candidate.evaluation.is_manual,
            property_mappings=current_candidate.evaluation.property_mappings,
          )
          continue

        # Check for heuristic changes
        count_changed = False
        quality_changed = False

        if current_candidate.heuristic.total_matches > 0:
          count_ratio = abs(current_candidate.heuristic.total_matches - candidate.heuristic.total_matches) / current_candidate.heuristic.total_matches
          if count_ratio >= self.count_change_threshold_ratio:
            count_changed = True
            change_reasons.append(f"Count changed by {count_ratio:.1%}")

        value_quality_diff = abs(current_candidate.heuristic.value_match_quality_avg - candidate.heuristic.value_match_quality_avg)
        if value_quality_diff >= 0.1:
          quality_changed = True
          change_reasons.append(f"Value quality changed by {value_quality_diff:.2f}")

        deep_quality_diff = abs(current_candidate.heuristic.deep_match_quality_avg - candidate.heuristic.deep_match_quality_avg)
        if deep_quality_diff >= 0.1:
          quality_changed = True
          change_reasons.append(f"Deep quality changed by {deep_quality_diff:.2f}")

        if count_changed or quality_changed:
          needs_evaluation = True
        else:
          # Copy over existing evaluation
          await rc_manager_new.update_evaluation(
            relation_id=candidate.relation_id,
            relation_name=current_candidate.evaluation.relation_name,
            justification=current_candidate.evaluation.justification,
            thought=current_candidate.evaluation.thought,
            result=current_candidate.evaluation.result,
            is_manual=current_candidate.evaluation.is_manual,
            property_mappings=current_candidate.evaluation.property_mappings,
          )

      if needs_evaluation:
        # Fetch existing accepted relations for this entity type pair
        existing_relations = await self._fetch_existing_relations(rc_manager_new, entity_a_type, entity_b_type)

        change_reason = "; ".join(set(change_reasons)) if change_reasons else "Heuristics require evaluation"
        filtered_groups[(entity_a_type, entity_b_type)] = (filtered_candidates, existing_relations, change_reason)

    self.evaluation_logger.info(f"Filtered to {len(filtered_groups)} groups requiring evaluation")
    return filtered_groups

  async def _fetch_existing_relations(self, rc_manager: RelationCandidateManager, entity_a_type: str, entity_b_type: str) -> list[str]:
    """Fetch names of existing accepted relations between two entity types."""
    try:
      # Query ontology DB for accepted relations between these types
      relations = await rc_manager.ontology_graph_db.find_relations(from_entity_type=entity_a_type, to_entity_type=entity_b_type, properties={constants.ONTOLOGY_VERSION_ID_KEY: rc_manager.ontology_version_id})

      relation_names = []
      for rel in relations:
        if rel.relation_properties and rel.relation_properties.get("eval_result") == FkeyEvaluationResult.ACCEPTED.value:
          rel_name = rel.relation_properties.get("eval_relation_name")
          if rel_name and rel_name != constants.CANDIDATE_RELATION_NAME:
            relation_names.append(rel_name)

      return list(set(relation_names))
    except Exception as e:
      self.evaluation_logger.error(f"Error fetching existing relations: {e}")
      return []

  async def prepare_candidate_group_data(self, group: RelationCandidateGroup, rc_manager: RelationCandidateManager) -> CandidateGroupData:
    """
    Prepare complete data for a candidate group including:
    - 3 example entity pairs with only mapped properties
    - Sub-entities for both entity types (recursive up to depth 10)
    - Existing relations between these types

    Args:
        group: The candidate group to prepare data for
        rc_manager: Relation candidate manager for fetching data

    Returns:
        CandidateGroupData with all information pre-loaded
    """
    self.evaluation_logger.debug(f"Preparing data for group {group.entity_a_type} -> {group.entity_b_type}")

    # Get up to 3 examples from the first candidate's heuristic
    examples: list[tuple[EntityExample, EntityExample]] = []
    if group.candidates:
      first_candidate = group.candidates[0]
      example_matches = first_candidate.heuristic.example_matches[:3]

      # Fetch sub-entity types for both entity types from ontology DB
      entity_a_sub_types = await rc_manager.fetch_sub_entities_recursive(group.entity_a_type, max_depth=10)
      entity_b_sub_types = await rc_manager.fetch_sub_entities_recursive(group.entity_b_type, max_depth=10)

      self.evaluation_logger.debug(f"Found {len(entity_a_sub_types)} sub-types for {group.entity_a_type}")
      self.evaluation_logger.debug(f"Found {len(entity_b_sub_types)} sub-types for {group.entity_b_type}")

      # Get the property mappings to filter properties
      property_mappings = first_candidate.heuristic.property_mappings
      entity_a_props = {pm.entity_a_property for pm in property_mappings}
      entity_b_props = {pm.entity_b_idkey_property for pm in property_mappings}

      # Fetch each example pair
      for example in example_matches:
        try:
          # Fetch entity A
          entity_a = await self.data_graph_db.fetch_entity(group.entity_a_type, example["entity_a_pk"])

          # Fetch entity B
          entity_b = await self.data_graph_db.fetch_entity(group.entity_b_type, example["entity_b_pk"])

          if entity_a and entity_b:
            # Filter properties to only mapped ones
            entity_a_filtered_props = {k: v for k, v in entity_a.all_properties.items() if k in entity_a_props}
            entity_b_filtered_props = {k: v for k, v in entity_b.all_properties.items() if k in entity_b_props}

            # Fetch sub-entities for entity A
            entity_a_subs = await self._fetch_sub_entities_for_instance(entity_a, entity_a_sub_types, max_depth=10)

            # Fetch sub-entities for entity B
            entity_b_subs = await self._fetch_sub_entities_for_instance(entity_b, entity_b_sub_types, max_depth=10)

            # Create EntityExample objects
            entity_a_example = EntityExample(entity_type=entity_a.entity_type, primary_key=entity_a.generate_primary_key(), properties=entity_a_filtered_props, sub_entities=entity_a_subs)

            entity_b_example = EntityExample(entity_type=entity_b.entity_type, primary_key=entity_b.generate_primary_key(), properties=entity_b_filtered_props, sub_entities=entity_b_subs)

            examples.append((entity_a_example, entity_b_example))

        except Exception as e:
          self.evaluation_logger.warning(f"Error fetching example entities: {e}")
          continue

    # Determine heuristic change reason (already computed in grouping)
    heuristic_change_reason = "Heuristics require evaluation"

    # Create the CandidateGroupData
    group_data = CandidateGroupData(group=group, examples=examples, heuristic_change_reason=heuristic_change_reason)

    self.evaluation_logger.debug(f"Prepared {len(examples)} examples for group {group.entity_a_type} -> {group.entity_b_type}")
    return group_data

  async def _fetch_sub_entities_for_instance(self, entity, sub_entity_types: list[str], max_depth: int = 10, current_depth: int = 0) -> list[EntityExample]:
    """
    Recursively fetch sub-entities for a given entity instance.

    Args:
        entity: The parent entity
        sub_entity_types: List of sub-entity type names to look for
        max_depth: Maximum recursion depth
        current_depth: Current recursion depth

    Returns:
        List of EntityExample objects representing sub-entities
    """
    if current_depth >= max_depth or not sub_entity_types:
      return []

    sub_entities = []

    # Fetch relations from this entity
    try:
      relations = await self.data_graph_db.fetch_entity_relations(entity.entity_type, entity.generate_primary_key(), max_results=100)

      # Find HAS relations (sub-entity relations)
      for relation in relations:
        if relation.relation_name == constants.DEFAULT_SUB_ENTITY_RELATION_NAME:
          # Check if target is a sub-entity type we're looking for
          if relation.to_entity.entity_type in sub_entity_types:
            # Fetch the sub-entity
            sub_entity = await self.data_graph_db.fetch_entity(relation.to_entity.entity_type, relation.to_entity.primary_key)

            if sub_entity:
              # Recursively fetch sub-sub-entities
              sub_sub_entities = await self._fetch_sub_entities_for_instance(sub_entity, sub_entity_types, max_depth, current_depth + 1)

              # Create EntityExample
              sub_entity_example = EntityExample(entity_type=sub_entity.entity_type, primary_key=sub_entity.generate_primary_key(), properties=sub_entity.get_external_properties(), sub_entities=sub_sub_entities)

              sub_entities.append(sub_entity_example)
    except Exception as e:
      self.evaluation_logger.warning(f"Error fetching sub-entities for {entity.entity_type}: {e}")

    return sub_entities

  async def evaluate_all(self, rc_manager_current: RelationCandidateManager | None, rc_manager_new: RelationCandidateManager):
    """
    Evaluates all relation candidate groups using isolated agent workers.
    Each worker gets its own queue of groups and processes them independently.

    :param rc_manager_current: (Optional) The relation candidate manager for the current ontology version.
    :param rc_manager_new: The relation candidate manager for the new ontology version.
    """
    self.evaluation_logger.info("Evaluating all relations for ontology_version_id: %s", rc_manager_new.ontology_version_id)
    if self.is_evaluating:
      self.evaluation_logger.warning("Evaluation is already in progress, skipping this run")
      return

    self.is_evaluating = True
    self.evaluation_count = 0

    try:
      # Fetch all entity types for the system prompt
      entity_types = await self.data_graph_db.get_all_entity_types()
      self.evaluation_logger.info(f"Found {len(entity_types)} entity types")

      # Step 1: Group and filter candidates by heuristic changes
      filtered_groups_raw = await self._group_and_filter_candidates(rc_manager_current, rc_manager_new)

      if not filtered_groups_raw:
        self.evaluation_logger.info("No candidate groups require evaluation")
        self.is_evaluating = False
        return

      # Step 2: Prepare CandidateGroupData for each group (with examples and sub-entities)
      self.evaluation_logger.info(f"Preparing data for {len(filtered_groups_raw)} candidate groups")
      groups_data_list: list[CandidateGroupData] = []

      for (entity_a_type, entity_b_type), (candidates, existing_relations, change_reason) in filtered_groups_raw.items():
        group = RelationCandidateGroup(entity_a_type=entity_a_type, entity_b_type=entity_b_type, candidates=candidates, existing_relations=existing_relations)

        # Prepare complete data with examples and sub-entities
        group_data = await self.prepare_candidate_group_data(group, rc_manager_new)
        group_data.heuristic_change_reason = change_reason
        groups_data_list.append(group_data)

      total_groups = len(groups_data_list)
      self.evaluation_logger.info(f"Prepared {total_groups} groups for evaluation")

      # Step 3: Distribute groups among workers
      num_workers = min(self.max_concurrent_evaluation, total_groups)
      worker_queues: list[list[CandidateGroupData]] = [[] for _ in range(num_workers)]

      # Round-robin distribution
      for idx, group_data in enumerate(groups_data_list):
        worker_idx = idx % num_workers
        worker_queues[worker_idx].append(group_data)

      self.evaluation_logger.info(f"Distributed {total_groups} groups among {num_workers} workers")
      for i, queue in enumerate(worker_queues):
        self.evaluation_logger.info(f"  Worker {i}: {len(queue)} groups")

      # Step 4: Create system prompt
      entity_types_str = ", ".join(sorted(entity_types))
      system_prompt = SYSTEM_PROMPT_1.format(entity_types=entity_types_str)

      # Get base LLM
      base_llm = LLMFactory().get_llm()

      # Create shared progress tracker (dict is thread-safe for simple increments in Python)
      # Using a dict instead of separate variables so workers can update the same object
      progress_tracker = {"completed_groups": 0, "total_groups": total_groups}

      # Step 5: Create isolated worker instances and launch them
      async def run_worker(worker_id: int, worker_queue: list[CandidateGroupData]):
        """Run a single worker with its own isolated state"""
        worker_logger = utils.get_logger(f"eval-worker-{worker_id}")

        if not worker_queue:
          worker_logger.info(f"Worker {worker_id} has no groups to process")
          return

        worker_logger.info(f"Worker {worker_id} starting with {len(worker_queue)} groups")

        try:
          # Create isolated AgentWorker instance
          agent_worker = AgentWorker(
            worker_id=worker_id,
            groups_queue=worker_queue.copy(),  # Give worker its own copy of the queue
            rc_manager=rc_manager_new,
            data_graph_db=self.data_graph_db,
            agent_recursion_limit=self.agent_recursion_limit,
            progress_tracker=progress_tracker,  # Shared progress tracking
          )

          agent = await agent_worker.create_agent(system_prompt, base_llm)
          worker_logger.info(f"Worker {worker_id}: Created agent with {len(worker_queue)} groups in queue")

          # Run agent in a loop to process all groups
          langfuse_handler = CallbackHandler()

          # Agent will call fetch_next_relation_candidate repeatedly until queue is empty
          if self.debug:
            # for candidate in worker_queue[worker_id].group.candidates:
            #     await agent_worker.accept_relation(candidate.relation_id, "DEBUG_MODE_RELATION_NAME", "[DEBUG_MODE] Accepting all relations", [
            #         PropertyMappingRule(
            #             entity_a_property=pm.entity_a_property,
            #             entity_b_idkey_property=pm.entity_b_idkey_property,
            #             match_type=ValueMatchType.EXACT
            #         )
            #         for pm in candidate.heuristic.property_mappings
            #     ])
            #     worker_logger.info(f"[DEBUG_MODE] Worker {worker_id}: Successfully accepted relation {candidate.relation_id}")
            return
          else:
            # Retry logic with exponential backoff
            max_retries = 5
            retry_delay = 2  # Initial delay in seconds

            for attempt in range(max_retries):
              try:
                await agent.ainvoke(
                  {
                    "messages": [
                      HumanMessage(
                        content=(
                          f"You have {len(worker_queue)} relation candidate groups to evaluate. "
                          f"For each group:\n"
                          f"1. Call fetch_next_relation_candidate to get the group\n"
                          f"2. Evaluate ALL candidates in the group\n"
                          f"3. Make accept/reject/unsure decisions\n"
                          f"4. Repeat until no more groups remain\n\n"
                          f"Start by fetching the first group."
                        )
                      )
                    ]
                  },
                  {"recursion_limit": self.agent_recursion_limit, "callbacks": [langfuse_handler]},
                )
                # If successful, break out of retry loop
                break
              except Exception as e:
                worker_logger.warning(f"Worker {worker_id} agent invocation attempt {attempt + 1}/{max_retries} failed: {e}")
                if attempt < max_retries - 1:
                  # Sleep before retrying (exponential backoff)
                  sleep_time = retry_delay * (2**attempt)
                  worker_logger.info(f"Worker {worker_id} retrying in {sleep_time} seconds...")
                  await asyncio.sleep(sleep_time)
                else:
                  # Last attempt failed, re-raise the exception
                  worker_logger.error(f"Worker {worker_id} all {max_retries} attempts failed")
                  raise

          # Collect evaluation count from worker
          worker_evaluations = agent_worker.total_evaluation_count
          self.evaluation_count += worker_evaluations

          # Update progress with final status
          completed = progress_tracker["completed_groups"]
          total = progress_tracker["total_groups"]
          self.agent_status_msg = f"Evaluating groups [{completed}/{total}] - Worker {worker_id} completed {worker_evaluations} evaluations"

          worker_logger.info(f"Worker {worker_id} completed - {worker_evaluations} evaluations made")

        except Exception as e:
          worker_logger.error(f"Worker {worker_id} error: {e}")
          worker_logger.error(traceback.format_exc())

      # Launch all workers concurrently
      worker_tasks = [run_worker(i, worker_queues[i]) for i in range(num_workers)]

      self.evaluation_logger.info(f"Launching {len(worker_tasks)} concurrent evaluation workers")
      await asyncio.gather(*worker_tasks, return_exceptions=True)

      self.evaluation_logger.info(f"All evaluation workers completed - Total evaluations made: {self.evaluation_count}")
      self.agent_status_msg = f"Evaluation complete - {self.evaluation_count} relations evaluated"

    except Exception as e:
      self.evaluation_logger.error(f"Error during evaluation: {e}")
      self.evaluation_logger.error(traceback.format_exc())
    finally:
      self.is_evaluating = False
