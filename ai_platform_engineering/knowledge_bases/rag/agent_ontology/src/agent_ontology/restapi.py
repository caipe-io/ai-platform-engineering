import os
from contextlib import asynccontextmanager
from typing import List

from agent_ontology.agent import OntologyAgent, RelationCandidateManager
from common.graph_db.base import GraphDB
from fastapi import FastAPI, HTTPException, BackgroundTasks
from fastapi.responses import JSONResponse
from common import constants, utils
from common.graph_db.neo4j.graph_db import Neo4jDB
from common.models.ontology import FkeyEvaluationResult, ValueMatchType, PropertyMappingRule
from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.interval import IntervalTrigger
import dotenv
import uvicorn
import redis.asyncio as redis

# Load environment variables from .env file
dotenv.load_dotenv()

logger = utils.get_logger("restapi")

port = int(os.getenv("SERVER_PORT", 8098))
SYNC_INTERVAL = int(os.getenv("SYNC_INTERVAL", 21600))  # 6 hours by default
MIN_COUNT_FOR_EVAL = int(os.getenv("MIN_COUNT_FOR_EVAL", int(3)))  # 3 by default
COUNT_CHANGE_THRESHOLD_RATIO = float(os.getenv("COUNT_CHANGE_THRESHOLD_RATIO", float(0.1)))  # 10% by default
MAX_CONCURRENT_PROCESSING = int(os.getenv("MAX_CONCURRENT_PROCESSING", int(40)))  # 40 by default
MAX_CONCURRENT_EVALUATION = int(os.getenv("MAX_CONCURRENT_EVALUATION", int(10)))  # 10 by default
AGENT_RECURSION_LIMIT = int(os.getenv("AGENT_RECURSION_LIMIT", int(100)))  # 100 by default

scheduler = AsyncIOScheduler()

# Initialize dependencies
logger.info("Initializing data graph database...")
graph_db: GraphDB = Neo4jDB(tenant_label=constants.DEFAULT_DATA_LABEL)

logger.info("Initializing ontology graph database...")
ontology_graph_db: GraphDB = Neo4jDB(tenant_label=constants.DEFAULT_SCHEMA_LABEL)

logger.info("Initializing key-value store...")
redis_client = redis.from_url(os.getenv("REDIS_URL", "redis://localhost:6379"), decode_responses=True)

logger.info("Initializing ontology agent...")
logger.info("Config:\nMax concurrent processing: %s\nMax concurrent evaluation: %s\nCount change threshold ratio: %s\nMin count for eval: %s", MAX_CONCURRENT_PROCESSING, MAX_CONCURRENT_EVALUATION, COUNT_CHANGE_THRESHOLD_RATIO, MIN_COUNT_FOR_EVAL)
agent: OntologyAgent = OntologyAgent(
  graph_db=graph_db, ontology_graph_db=ontology_graph_db, redis=redis_client, min_count_for_eval=MIN_COUNT_FOR_EVAL, count_change_threshold_ratio=COUNT_CHANGE_THRESHOLD_RATIO, max_concurrent_evaluation=MAX_CONCURRENT_EVALUATION, agent_recursion_limit=AGENT_RECURSION_LIMIT
)


@asynccontextmanager
async def lifespan(_: FastAPI):
  logger.info("Setting up key-value store with ontology version")
  if SYNC_INTERVAL == 0:
    logger.warning("Automatic heuristics processing and evaluation is disabled, heuristics will be updated only on demand (via REST endpoints)")
  else:
    logger.info("Running the ontology agent periodically every %s seconds ...", SYNC_INTERVAL)
    scheduler.add_job(agent.process_and_evaluate_all, trigger=IntervalTrigger(seconds=SYNC_INTERVAL))
    scheduler.start()

  try:
    # Yield control to the event loop to allow server to start
    yield
  finally:
    try:
      if scheduler.running:
        scheduler.shutdown(wait=False)
    finally:
      try:
        await graph_db.close()
      finally:
        try:
          await ontology_graph_db.close()
        finally:
          await redis_client.aclose()


app = FastAPI(title="Ontology Agent Admin Server", lifespan=lifespan)


async def get_rc_manager_with_latest_ontology() -> RelationCandidateManager | None:
  ontology_version_id = await redis_client.get(constants.KV_ONTOLOGY_VERSION_ID_KEY)
  if ontology_version_id is None:
    logger.error("No ontology version found, cannot get relation candidate manager")
    return None
  return RelationCandidateManager(graph_db=graph_db, ontology_graph_db=ontology_graph_db, ontology_version_id=ontology_version_id, client_name=agent.agent_name, redis_client=redis_client)


#####
# API Endpoints for manual relation management
#####
@app.post("/v1/graph/ontology/agent/relation/accept/{relation_id:path}")
async def accept_relation(relation_id: str, relation_name: str, property_mapping_rules: List[PropertyMappingRule]):
  """
  Accepts a foreign key relation

  Args:
      relation_id: The relation ID
      relation_name: The name of the relation
      property_mappings: List of property mapping rules

  """
  logger.warning("Accepting foreign key relation %s", relation_id)
  if agent.is_evaluating or agent.is_processing:
    return JSONResponse(status_code=400, content={"message": "Ontology processing/evaluation is in progress"})

  rc_manager = await get_rc_manager_with_latest_ontology()
  if rc_manager is None:
    raise HTTPException(status_code=400, detail="Ontology not initialized. Please trigger heuristics processing first via POST /v1/graph/ontology/agent/regenerate_ontology")

  # Fetch the candidate
  candidate = await rc_manager.fetch_candidate(relation_id)
  if candidate is None:
    raise HTTPException(status_code=404, detail=f"Relation candidate {relation_id} not found")

  # Check if an evaluation already exists
  if candidate.evaluation is not None:
    raise HTTPException(status_code=400, detail=f"Relation candidate {relation_id} already has an evaluation, you must undo it first before accepting")

  property_mappings_from_heuristic = candidate.heuristic.property_mappings

  # Validate that the property mappings are the same as the ones from the heuristic
  # Create sets of property pairs for comparison
  heuristic_property_pairs = {(pm.entity_a_property, pm.entity_b_idkey_property) for pm in property_mappings_from_heuristic}
  request_property_pairs = {(pm.entity_a_property, pm.entity_b_idkey_property) for pm in property_mapping_rules}
  if heuristic_property_pairs != request_property_pairs:
    raise HTTPException(status_code=400, detail=f"Property mappings do not match the heuristic. Expected: {heuristic_property_pairs}, Got: {request_property_pairs}")

  # Update the evaluation
  await rc_manager.update_evaluation(relation_id=relation_id, relation_name=relation_name, result=FkeyEvaluationResult.ACCEPTED, justification="Manually accepted by user", thought="Manually accepted by user", is_manual=True, property_mappings=property_mapping_rules)

  # Sync the relation
  await rc_manager.sync_relation(relation_id)

  return JSONResponse(status_code=200, content={"message": "Relation accepted"})


@app.post("/v1/graph/ontology/agent/relation/reject/{relation_id:path}")
async def reject_relation(relation_id: str, justification: str):
  """
  Reject a foreign key relation

  Args:
      relation_id: The relation ID
      justification: Justification for rejecting the relation
  """
  logger.warning("Rejecting foreign key relation %s", relation_id)
  if agent.is_evaluating or agent.is_processing:
    return JSONResponse(status_code=400, content={"message": "Ontology processing/evaluation is in progress"})
  rc_manager = await get_rc_manager_with_latest_ontology()
  if rc_manager is None:
    raise HTTPException(status_code=400, detail="Ontology not initialized. Please trigger heuristics processing first via POST /v1/graph/ontology/agent/regenerate_ontology")

  # Fetch the candidate
  candidate = await rc_manager.fetch_candidate(relation_id)
  if candidate is None:
    raise HTTPException(status_code=404, detail=f"Relation candidate {relation_id} not found")

  # Check if an evaluation already exists
  if candidate.evaluation is not None:
    raise HTTPException(status_code=400, detail=f"Relation candidate {relation_id} already has an evaluation, you must undo it first before rejecting")

  # Convert property mappings to PropertyMappingRule objects with NONE match type
  property_mapping_rules = [PropertyMappingRule(entity_a_property=pm.entity_a_property, entity_b_idkey_property=pm.entity_b_idkey_property, match_type=ValueMatchType.NONE) for pm in candidate.heuristic.property_mappings]

  # Update the evaluation
  await rc_manager.update_evaluation(
    relation_id=relation_id,
    relation_name=constants.CANDIDATE_RELATION_NAME,
    result=FkeyEvaluationResult.REJECTED,
    justification="Manually rejected by user: " + justification,
    thought="Manually rejected by user",
    is_manual=True,
    property_mappings=property_mapping_rules,
  )

  # sync the relation
  await rc_manager.sync_relation(relation_id)
  return JSONResponse(status_code=200, content={"message": "Relation rejected"})


@app.post("/v1/graph/ontology/agent/relation/undo_evaluation/{relation_id:path}")
async def undo_evaluation(relation_id: str):
  """
  Undo an accepted or rejected foreign key relation
  """
  logger.warning("Un-rejecting foreign key relation %s", relation_id)
  if agent.is_evaluating or agent.is_processing:
    return JSONResponse(status_code=400, content={"message": "Ontology processing/evaluation is in progress"})

  rc_manager = await get_rc_manager_with_latest_ontology()
  if rc_manager is None:
    raise HTTPException(status_code=400, detail="Ontology not initialized. Please trigger heuristics processing first via POST /v1/graph/ontology/agent/regenerate_ontology")
  # Remove the evaluation
  await rc_manager.remove_evaluation(relation_id)

  # Sync the relation
  await rc_manager.sync_relation(relation_id)
  return JSONResponse(status_code=200, content={"message": "Evaluation undone"})


@app.post("/v1/graph/ontology/agent/relation/evaluate/{relation_id:path}")
async def evaluate_relation(relation_id: str):
  """
  [DEPRECATED] Single-candidate evaluation endpoint

  This endpoint has been deprecated. Single-candidate evaluation adds unnecessary complexity.

  Use the following alternatives:
  - For manual acceptance: POST /v1/graph/ontology/agent/relation/accept/{relation_id}
  - For manual rejection: POST /v1/graph/ontology/agent/relation/reject/{relation_id}
  - For batch evaluation: POST /v1/graph/ontology/agent/regenerate_ontology
  """
  raise HTTPException(status_code=501, detail="Single-candidate evaluation is not implemented. Use manual accept/reject endpoints or batch evaluation instead.")


@app.post("/v1/graph/ontology/agent/relation/sync/{relation_id:path}")
async def sync_relation(relation_id: str):
  """
  Syncs a single foreign key relation with the graph database
  """
  logger.warning("Syncing foreign key relation %s", relation_id)
  if agent.is_evaluating or agent.is_processing:
    return JSONResponse(status_code=400, content={"message": "Ontology processing/evaluation is in progress"})
  rc_manager = await get_rc_manager_with_latest_ontology()
  if rc_manager is None:
    raise HTTPException(status_code=400, detail="Ontology not initialized. Please trigger heuristics processing first via POST /v1/graph/ontology/agent/regenerate_ontology")
  await rc_manager.sync_relation(relation_id)
  return JSONResponse(status_code=200, content={"message": "Submitted"})


@app.post("/v1/graph/ontology/agent/relation/heuristics/batch")
async def get_relation_heuristics_batch(relation_ids: List[str]):
  """
  Get heuristics for multiple relations in a batch.
  Returns a dictionary mapping relation_id to heuristic data (counts, examples, quality metrics).

  Request body: Array of relation IDs
  Example: ["relation_id_1", "relation_id_2", ...]
  """
  logger.info(f"Fetching heuristics for {len(relation_ids)} relations in batch")
  rc_manager = await get_rc_manager_with_latest_ontology()
  if rc_manager is None:
    raise HTTPException(status_code=400, detail="Ontology not initialized. Please trigger heuristics processing first via POST /v1/graph/ontology/agent/regenerate_ontology")

  heuristics_dict = await rc_manager.fetch_heuristics_batch(relation_ids)

  # Convert to JSON-serializable format
  result = {}
  for relation_id, heuristic in heuristics_dict.items():
    if heuristic:
      result[relation_id] = heuristic.model_dump(mode="json")
    else:
      result[relation_id] = None

  return JSONResponse(status_code=200, content=result)


@app.post("/v1/graph/ontology/agent/relation/evaluations/batch")
async def get_relation_evaluations_batch(relation_ids: List[str]):
  """
  Get evaluations and sync status for multiple relations in a batch.
  Returns a dictionary mapping relation_id to evaluation and sync status data.

  Request body: Array of relation IDs
  Example: ["relation_id_1", "relation_id_2", ...]

  Response format:
  {
      "relation_id_1": {
          "evaluation": {
              "relation_name": "HAS_ACCOUNT",
              "result": "ACCEPTED",
              "justification": "...",
              "thought": "...",
              "last_evaluated": 1234567890,
              "is_manual": true,
              "is_sub_entity_relation": false,
              "directionality": "FROM_A_TO_B",
              "property_mappings": [...]
          },
          "sync_status": {
              "is_synced": true,
              "last_synced": 1234567890,
              "error_message": ""
          }
      },
      ...
  }
  """
  logger.info(f"Fetching evaluations and sync status for {len(relation_ids)} relations in batch")
  rc_manager = await get_rc_manager_with_latest_ontology()
  if rc_manager is None:
    raise HTTPException(status_code=400, detail="Ontology not initialized. Please trigger heuristics processing first via POST /v1/graph/ontology/agent/regenerate_ontology")

  result = await rc_manager.fetch_evaluations_and_sync_status_batch(relation_ids)

  return JSONResponse(status_code=200, content=result)


@app.post("/v1/graph/ontology/agent/regenerate_ontology")
async def regenerate_ontology(background_tasks: BackgroundTasks):
  """
  Asks the agent to regenerate the ontology graph based on current foreign key relations in the data graph
  """
  logger.warning("Regenerating ontology graph")
  if agent.is_processing or agent.is_evaluating:
    return JSONResponse(status_code=400, content={"message": "Heuristics processing is in progress"})
  background_tasks.add_task(agent.process_and_evaluate_all)
  return JSONResponse(status_code=200, content={"message": "Submitted"})


@app.delete("/v1/graph/ontology/agent/clear")
async def clear_ontology():
  """
  Clears all foreign key relations and the ontology graph
  """
  logger.warning("Clearing all foreign key relations and the ontology graph")
  if agent.is_processing or agent.is_evaluating:
    return JSONResponse(status_code=400, content={"message": "Ontology processing is in progress"})
  ontology_version_id = await redis_client.get(constants.KV_ONTOLOGY_VERSION_ID_KEY)
  if ontology_version_id is None:
    raise HTTPException(status_code=400, detail="Ontology not initialized. Nothing to clear.")

  # Remove relations and entities from the ontology graph
  await agent.ontology_graph_db.remove_relation(None, {constants.ONTOLOGY_VERSION_ID_KEY: ontology_version_id})
  await agent.ontology_graph_db.remove_entity(None, {constants.ONTOLOGY_VERSION_ID_KEY: ontology_version_id})

  # Remove only the relations from the data graph
  await agent.data_graph_db.remove_relation(None, {constants.ONTOLOGY_VERSION_ID_KEY: ontology_version_id})

  # Clear data from the redis
  await redis_client.delete(constants.KV_ONTOLOGY_VERSION_ID_KEY)

  # Delete all relation heuristics keys
  pattern = f"{constants.REDIS_GRAPH_RELATION_HEURISTICS_PREFIX}*"
  cursor = 0
  while True:
    cursor, keys = await redis_client.scan(cursor, match=pattern, count=100)  # type: ignore
    if keys:
      await redis_client.delete(*keys)  # type: ignore
    if cursor == 0:
      break

  return JSONResponse(status_code=200, content={"message": "Cleared"})


@app.get("/v1/graph/ontology/agent/ontology_version")
async def get_ontology_version():
  ontology_version_id = await redis_client.get(constants.KV_ONTOLOGY_VERSION_ID_KEY)
  if ontology_version_id is None:
    raise HTTPException(status_code=400, detail="Ontology not initialized. Please trigger heuristics processing first via POST /v1/graph/ontology/agent/regenerate_ontology")
  return JSONResponse(status_code=200, content={"ontology_version_id": ontology_version_id})


####
# Endpoints for debugging
####
@app.post("/v1/graph/ontology/agent/debug/process_all")
async def process_all():
  """
  Asks the agent to process all entities for heuristics, this is used for debugging
  For debugging purposes
  """
  logger.warning("Processing all entities for heuristics")
  rc_manager = await get_rc_manager_with_latest_ontology()
  if rc_manager is None:
    raise HTTPException(status_code=400, detail="Ontology not initialized. Please trigger heuristics processing first via POST /v1/graph/ontology/agent/regenerate_ontology")
  await agent.process_all(rc_manager)
  return JSONResponse(status_code=200, content={"message": "Submitted for processing"})


#####
# API Endpoints for debugging
#####


@app.post("/v1/graph/ontology/agent/debug/cleanup")
async def cleanup():
  """
  Cleans up old relations candidates that are not part of current heuristics version
  For debugging purposes
  """
  rc_manager = await get_rc_manager_with_latest_ontology()
  if rc_manager is None:
    raise HTTPException(status_code=400, detail="Ontology not initialized. Please trigger heuristics processing first via POST /v1/graph/ontology/agent/regenerate_ontology")
  await rc_manager.cleanup()  # This will remove all relations that are no longer candidates, as well as applied relations
  return JSONResponse(status_code=200, content={"message": "Submitted"})


#####
# Health and config endpoints
#####
@app.get("/health")
async def liveness():
  """Liveness probe: process health only, no dependency checks."""
  return {"status": "ok"}


@app.get("/v1/graph/ontology/agent/status")
async def healthz():
  return {
    "status": "healthy",
    "redis_ready": "true",
    "graph_db_ready": "true",
    "ontology_graph_db_ready": "true",
    "is_processing": agent.is_processing,
    "is_evaluating": agent.is_evaluating,
    "last_evaluation_run_timestamp": agent.last_evaluation_run_timestamp,
    "max_concurrent_processing": MAX_CONCURRENT_PROCESSING,
    "max_concurrent_evaluation": MAX_CONCURRENT_EVALUATION,
    "min_count_for_eval": MIN_COUNT_FOR_EVAL,
    "count_change_threshold_ratio": COUNT_CHANGE_THRESHOLD_RATIO,
    "sync_interval_seconds": SYNC_INTERVAL,
    "agent_recursion_limit": AGENT_RECURSION_LIMIT,
    "agent_status_msg": agent.agent_status_msg,
  }


if __name__ == "__main__":
  uvicorn.run(app, host="0.0.0.0", port=port)
