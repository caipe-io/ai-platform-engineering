
import os
from pymilvus import MilvusClient
from common.mongo_storage import MongoStorage
from common.graph_db.neo4j.graph_db import Neo4jDB
from common.constants import DEFAULT_DATA_LABEL, DEFAULT_SCHEMA_LABEL
from server.restapi import milvus_uri, default_collection_name_docs, graph_rag_enabled, neo4j_addr
storage = MongoStorage()

legacy_default_collection_name_graph = "graph_rag_default"
delete_delay_seconds = int(os.getenv("DELETE_DELAY_SECONDS", "20"))

async def _delete_all_nodes_batch(graph_db: Neo4jDB, name: str):
    query = """
    MATCH (n)
    CALL {
        WITH n
        DETACH DELETE n
    } IN TRANSACTIONS OF 1000 ROWS
    """
    await graph_db.raw_query(query)
    print(f"  Deleted all nodes from {name} graph")

async def clear_all():
    print("🛑 WARNING 🛑 This will DELETE ALL DATA in the Vector databases, Graph databases, and RAG MongoDB. 🛑 Proceed with caution!🛑")

    for i in range(delete_delay_seconds, 0, -1):
        print(f"DELETING ALL in {i} seconds... Press Ctrl+C to abort")
        import time
        time.sleep(1)

    data_graph_db = Neo4jDB(tenant_label=DEFAULT_DATA_LABEL, uri=neo4j_addr)
    ontology_graph_db = Neo4jDB(tenant_label=DEFAULT_SCHEMA_LABEL, uri=neo4j_addr)

    if graph_rag_enabled:
        print("🛑 Deleting data from ontology graph...")
        await _delete_all_nodes_batch(ontology_graph_db, "ontology")
        
        print("🛑 Deleting data from data graph...")
        await _delete_all_nodes_batch(data_graph_db, "data")
    else:
        print("Graph RAG is disabled, skipping graph deletion.")

    client = MilvusClient(uri=milvus_uri)
    print(f"🛑 Deleting collection {default_collection_name_docs}...")
    client.drop_collection(collection_name=default_collection_name_docs)

    print(f"🛑 Deleting legacy collection {legacy_default_collection_name_graph}...")
    client.drop_collection(collection_name=legacy_default_collection_name_graph)

    print("🛑 Flushing RAG MongoDB ...")
    for collection_name in await storage.db.list_collection_names():
      if collection_name.startswith("rag_"):
        await storage.db[collection_name].delete_many({})
    await storage.aclose()


if __name__ == "__main__":
    import asyncio
    asyncio.run(clear_all())