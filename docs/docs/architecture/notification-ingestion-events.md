# Ingestion Events

- RAG job lifecycle events notify the authenticated trigger identity using per-attempt event keys.
- Trigger identities are omitted from serialized/log representations and removed when a datasource is deleted.
- Configure the shared internal publisher endpoint/token in the RAG server and ingestors; missing configuration disables publication.
- Delivery failure does not fail ingestion. A pre-publication crash remains outside the queue guarantee.
