# RAG Ingestors

This directory contains ingestors. An ingestor is a script that ingests data from a specific source into the RAG system. Ingestors can be scheduled to run at regular intervals to keep data up-to-date.

## Available Ingestors

### Web Loader

This is a default web page ingestor that can crawl sitemaps and ingest web pages. This is included by default when you set up the RAG system. Since it's triggered via Web UI, it is more tightly integrated with the Server and Redis job management system.

### Dummy Graph Ingestor

This is a sample ingestor that creates dummy graph entities for testing purposes. It demonstrates how to create graph nodes in the RAG system.

### [Backstage Ingestor](src/ingestors/backstage/README.md)

Ingests entities from a Backstage catalog into the RAG system as graph entities. Fetches all catalog entities with pagination support and converts them to searchable entities with proper metadata.

[📖 View detailed documentation →](src/ingestors/backstage/README.md)

### [ArgoCD Ingestor](src/ingestors/argocd/README.md)

Ingests entities from ArgoCD into the RAG system as graph entities. Fetches applications, projects, clusters, repositories, applicationsets, and RBAC roles from your ArgoCD instance.

[📖 View detailed documentation →](src/ingestors/argocd/README.md)

### [AWS Ingestor](src/ingestors/aws/README.md)

Ingests AWS resources as graph entities into the RAG system. Discovers and ingests various AWS resources across all regions including EC2 instances, S3 buckets, RDS databases, Lambda functions, and more.

[📖 View detailed documentation →](src/ingestors/aws/README.md)

### [Kubernetes (K8s) Ingestor](src/ingestors/k8s/README.md)

Ingests Kubernetes resources as graph entities into the RAG system. Discovers and ingests both standard Kubernetes resources and Custom Resource Definitions (CRDs) from your cluster.

[📖 View detailed documentation →](src/ingestors/k8s/README.md)

### [Slack Ingestor](src/ingestors/slack/README.md)

Ingests conversations from Slack channels as documents into the RAG system. Each channel becomes a datasource, and each thread (or standalone message) becomes a document.

[📖 View detailed documentation →](src/ingestors/slack/README.md)

### [Webex Ingestor](src/ingestors/webex/README.md)

Ingests messages from Webex spaces as documents into the RAG system. Each space becomes a datasource, and each message becomes a document.

[📖 View detailed documentation →](src/ingestors/webex/README.md)

### [Confluence Ingestor](src/ingestors/confluence/README.md)

Ingests pages from Confluence spaces as documents into the RAG system. Supports both on-demand page ingestion and automatic periodic syncing of configured spaces.

[📖 View detailed documentation →](src/ingestors/confluence/README.md)

## Running Ingestors

**Development (Trusted Network):**
```bash
uv sync
source ./.venv/bin/activate 
export RAG_SERVER_URL="http://localhost:9446" 
python3 src/ingestors/simple_ingestor/ingestor.py
```

**Production (OAuth2 Client Credentials):**
```bash
export RAG_SERVER_URL="http://rag-server:9446"
export INGESTOR_OIDC_ISSUER="https://your-keycloak.com/realms/production"
export INGESTOR_OIDC_CLIENT_ID="rag-ingestor"
export INGESTOR_OIDC_CLIENT_SECRET="xxx"
python3 src/ingestors/simple_ingestor/ingestor.py
```

The ingestor automatically:
- Fetches OAuth2 access tokens via client credentials grant
- Caches tokens and refreshes before expiry
- Includes Bearer token in all RAG server API calls

## Creating a Simple Ingestor

Here's a basic ingestor that ingests some strings and manages job state:

### Prerequisites

- uv
- Python 3.14 installed with the necessary dependencies.
- Ensure you have the RAG server running and accessible.


### Setup the folder structure

```
# Replace the simple_ingestor with your ingestor name
mkdir -p src/ingestors/simple_ingestor
touch src/ingestors/simple_ingestor/ingestor.py
```

### Then add the following code to `ingestor.py`

```python
import time
import asyncio
from common.ingestor import IngestorBuilder, Client
from common.models.rag import DataSourceInfo, DocumentMetadata
from common.job_manager import JobStatus
from langchain_core.documents import Document

async def sync_data(client: Client):
    """Simple sync function that creates documents and ingests them"""
    
    # 1. Create datasource first
    
    # Create a unique but deterministic datasource ID based on what is being ingested e.g. sitemap URL, folder name etc.
    datasource_id = "simple-datasource"
    datasource = DataSourceInfo(
        datasource_id=datasource_id,
        ingestor_id=client.ingestor_id or "",
        description="Simple test datasource",
        source_type="documents",
        last_updated=int(time.time())
    )
    await client.upsert_datasource(datasource)
    
    # 2. Create some sample documents from simple strings
    document_texts = [
        "This is the first sample document with some interesting content about AI.",
        "Here's another document discussing machine learning and data processing.",
        "A third document containing information about natural language processing."
    ]
    
    # Convert strings to Document objects with proper metadata
    documents = []
    for i, text in enumerate(document_texts):
        # Create DocumentMetadata with proper structure
        doc_metadata = DocumentMetadata(
            document_id=f"doc_{i+1}", # Define a unique but deterministic document ID - e.g. url, file path, etc.
            document_type="text",
            datasource_id=datasource_id,
            ingestor_id=client.ingestor_id or "",
            title=f"Sample Document {i+1}",
            description=f"Simple test document {i+1}",
            fresh_until=None,  # Use default freshness
            metadata={"source": "simple_ingestor"}
        )
        
        doc = Document(
            page_content=text,
            metadata=doc_metadata.model_dump()
        )
        documents.append(doc)
    
    # 3. Create a new job for this ingestion
    job_response = await client.create_job(
        datasource_id=datasource_id,
        job_status=JobStatus.IN_PROGRESS,
        message="Starting simple document ingestion",
        total=len(documents)
    )
    job_id = job_response["job_id"]
    
    try:
        # 4. Ingest documents (automatic batching)
        await client.ingest_documents(job_id, datasource_id, documents)
        
        # 5. Mark job as completed
        await client.update_job(
            job_id=job_id,
            job_status=JobStatus.COMPLETED,
            message=f"Successfully ingested {len(documents)} documents"
        )
        
    except Exception as e:
        # Handle failure - add error messages and mark as failed
        await client.add_job_error(job_id, [str(e)])
        await client.update_job(
            job_id=job_id,
            job_status=JobStatus.FAILED,
            message=f"Ingestion failed: {e}"
        )
        raise

# Run the ingestor
if __name__ == "__main__":
    IngestorBuilder()\
        .name("simple-ingestor")\
        .type("example")\
        .sync_with_fn(sync_data)\
        .every(300)\
        .run()
```
