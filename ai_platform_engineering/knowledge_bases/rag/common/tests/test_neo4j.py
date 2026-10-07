"""
Simple tests for Neo4j fuzzy_search_batch functionality.
Assumes Neo4j is running at localhost:7687 with default credentials (neo4j/password).
"""

import asyncio
from common.graph_db.neo4j.graph_db import Neo4jDB
from common.models.rag import StructuredEntity


async def setup_test_data(db: Neo4jDB):
  """Create some test entities."""
  entities = [
    StructuredEntity(entity_type="User", primary_key_properties=["id"], all_properties={"id": "user-alice-001", "name": "Alice Smith", "role": "Engineer"}),
    StructuredEntity(entity_type="User", primary_key_properties=["id"], all_properties={"id": "user-bob-002", "name": "Bob Johnson", "role": "Manager"}),
    StructuredEntity(entity_type="Project", primary_key_properties=["id"], all_properties={"id": "proj-apollo-001", "name": "Apollo", "owner": "user-alice-001"}),
  ]
  await db.update_entity("User", entities[:2])
  await db.update_entity("Project", [entities[2]])
  await asyncio.sleep(1)  # Wait for indexing


async def test_single_query():
  """Test a single query in a batch."""
  print("Testing: fuzzy_search_batch() with single query")

  db = Neo4jDB(tenant_label="TestStructuredEntity")

  await db.setup()
  await setup_test_data(db)

  # Search for alice (use strict=False for partial matching)
  results = await db.fuzzy_search_batch(
    batch_keywords=[[["alice"]]],
    strict=False,  # Use standard analyzer for partial matching
    max_results=10,
  )

  print(f"✓ Single query returned {len(results)} result lists")
  print(f"✓ Found {len(results[0])} matches for 'alice'")
  if results[0]:
    print(f"  - Match: {results[0][0][0].all_properties['id']}")

  await db.remove_entity(None, None)
  await db.close()


async def test_multiple_queries():
  """Test multiple queries in a single batch."""
  print("Testing: fuzzy_search_batch() with multiple queries (batched)")

  db = Neo4jDB(tenant_label="TestStructuredEntity")

  await db.setup()
  await setup_test_data(db)

  # Search for alice, bob, and apollo in one batch (in their IDs)
  results = await db.fuzzy_search_batch(
    batch_keywords=[[["alice"]], [["bob"]], [["apollo"]]],
    strict=False,  # Use standard analyzer for partial matching
    max_results=10,
  )

  print(f"✓ Batch query returned {len(results)} result lists")
  print(f"  - Query 1 (alice): {len(results[0])} matches")
  print(f"  - Query 2 (bob): {len(results[1])} matches")
  print(f"  - Query 3 (apollo): {len(results[2])} matches")

  if results[0]:
    print(f"    Found: {results[0][0][0].all_properties['id']}")
  if results[1]:
    print(f"    Found: {results[1][0][0].all_properties['id']}")
  if results[2]:
    print(f"    Found: {results[2][0][0].all_properties['id']}")

  await db.remove_entity(None, None)
  await db.close()


async def test_type_filter():
  """Test filtering by entity type using exclude filter."""
  print("Testing: fuzzy_search_batch() with exclude_type_filter")

  db = Neo4jDB(tenant_label="TestStructuredEntity")

  await db.setup()
  await setup_test_data(db)

  # Search and exclude Project entities (should only find Users)
  results = await db.fuzzy_search_batch(
    batch_keywords=[[["alice", "apollo"]]],  # Search for both
    exclude_type_filter=["Project"],  # But exclude Project
    strict=False,
    max_results=10,
  )

  print(f"✓ Exclude filter test: found {len(results[0])} non-Project entities")
  if results[0]:
    for entity, score in results[0]:
      print(f"  - StructuredEntity type: {entity.entity_type}, id: {entity.all_properties['id']}")

  await db.remove_entity(None, None)
  await db.close()


if __name__ == "__main__":
  print("Running Neo4j fuzzy_search_batch tests...\n")

  print("Test 1: Single query")
  asyncio.run(test_single_query())

  print("\nTest 2: Multiple queries in batch")
  asyncio.run(test_multiple_queries())

  print("\nTest 3: Exclude type filter")
  asyncio.run(test_type_filter())

  print("\n✓ All tests completed!")
