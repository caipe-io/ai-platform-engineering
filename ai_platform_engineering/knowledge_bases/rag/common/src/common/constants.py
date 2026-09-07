# ============================================================================
# Common constants used across the application
# ============================================================================

# =============================
# Graph database constants
# =============================
PRIMARY_ID_KEY = "_entity_pk"  # The primary identity key
ALL_IDS_KEY = "_all_ids"  # The key to store the values of the identity keys
ALL_IDS_PROPS_KEY = "_all_ids_props"  # The key to store property names of the identity keys - the first one is always the primary identity key
FRESH_UNTIL_KEY = "_fresh_until"
ENTITY_TYPE_KEY = "_entity_type"
PROP_DELIMITER = "_|||_"  # Delimiter used for concatenating multiple property values (like identity properties)
LAST_UPDATED_KEY = "_last_updated"
INGESTOR_ID_KEY = "_ingestor_id"
DATASOURCE_ID_KEY = "_datasource_id"
JSON_ENCODED_KEY = "_json_encoded"
RELATION_UPDATED_BY_KEY = "_relation_updated_by"

# Entity constants
DEFAULT_DATA_LABEL = "NxsDataEntity"
DEFAULT_SCHEMA_LABEL = "NxsSchemaEntity"
SUB_ENTITY_LABEL = "NxsSubEntity"
PROPERTY_VALUE_MAX_LENGTH = 200  # Maximum length for a property value
PARENT_ENTITY_PK_KEY = "_parent_entity_pk"  # Key for parent entity primary key in sub-entities
PARENT_ENTITY_TYPE_KEY = "_parent_entity_type"  # Key for parent entity type in sub-entities
SUB_ENTITY_INDEX_KEY = "_sub_entity_index"  # Key for sub-entity index in list

# Relation constants
ONTOLOGY_RELATION_ID_KEY = "_ontology_relation_id"  # The id used to track relations in data graph and the reference to the relation in ontology graph
ONTOLOGY_VERSION_ID_KEY = "_ontology_version_id"  # The id used to track the ontology version
ENTITY_TYPE_NAME_KEY = "entity_type_name"  # The name of the entity type - used in ontology database to track entity types
DEFAULT_SUB_ENTITY_RELATION_NAME = "HAS"  # The name of the relation between a parent entity and an auto-generated sub-entity
RELATION_PK_KEY = "_relation_pk"  # The primary key for a relation - used to uniquely identify relations with the same name between the same entity types
CANDIDATE_RELATION_NAME = "_CANDIDATE"  # The name used for all candidate relations in the ontology graph

# =============================
# Redis constants
# =============================
KV_ONTOLOGY_VERSION_ID_KEY = "graph_rag/ontology_version_id"  # Ontology version id key

# Redis key prefixes for metadata storage
REDIS_DATASOURCE_PREFIX = "rag/datasource:"
REDIS_DATASOURCE_DOCUMENTS_PREFIX = "rag/datasource_documents:"
REDIS_INGESTOR_PREFIX = "rag/ingestor:"
REDIS_INGESTOR_PREVIEW_RESPONSE_PREFIX = "rag/ingestor_preview:"

# Redis keys for MCP tool configuration
REDIS_MCP_TOOL_CONFIG_PREFIX = "rag/mcp/tool:"  # per-tool: {prefix}{tool_id}
REDIS_MCP_BUILTIN_CONFIG_KEY = "rag/mcp/builtin_config"  # singleton for fetch/graph toggles

# Redis key prefixes for job management
REDIS_JOB_PREFIX = "job:"
REDIS_JOB_DATASOURCE_INDEX_PREFIX = "jobs:by_datasource:"
REDIS_JOB_ERRORS_SUFFIX = ":errors"

# Redis key prefixes for graph relation heuristics
REDIS_GRAPH_RELATION_HEURISTICS_PREFIX = "graph_relation_heuristics:"


# =============================
# Other constants
# =============================
WEBLOADER_INGESTOR_REDIS_QUEUE = "ingestor:webloader:requests"
WEBLOADER_INGESTOR_TYPE = "webloader"
WEBLOADER_INGESTOR_NAME = "default_webloader"

CONFLUENCE_INGESTOR_REDIS_QUEUE = "ingestor:confluence:requests"
CONFLUENCE_INGESTOR_TYPE = "confluence"
CONFLUENCE_INGESTOR_NAME = "default_confluence"

SLACK_INGESTOR_REDIS_QUEUE = "ingestor:slack:requests"
SLACK_INGESTOR_TYPE = "slack"
SLACK_INGESTOR_NAME = "default_slack"

JIRA_INGESTOR_REDIS_QUEUE = "ingestor:jira:requests"
JIRA_INGESTOR_TYPE = "jira"
JIRA_INGESTOR_NAME = "default_jira"

WEBEX_INGESTOR_REDIS_QUEUE = "ingestor:webex:requests"
WEBEX_INGESTOR_TYPE = "webex"
WEBEX_INGESTOR_NAME = "default_webex"


def ingestor_request_queue(ingestor_type: str, ingestor_id: str) -> str:
  """Return the queue owned by one logical ingestor instance.

  Replicas with the same stable id intentionally share a queue for work
  distribution. Different ids never consume and discard each other's jobs.
  """
  return f"ingestor:{ingestor_type}:{ingestor_id}:requests"

# Default reload interval for datasources without an explicit reload_interval in metadata (in seconds)
DEFAULT_RELOAD_INTERVAL = 86400  # 24 hours

# Minimum reload interval for datasources (in seconds)
# Prevents excessive resource usage from too-frequent reloads
MIN_RELOAD_INTERVAL = 60

# Database-managed ingestors periodically re-read datasource schedules so a
# source added while the worker is sleeping is picked up promptly. This is an
# internal scheduling detail, not a datasource refresh setting.
DATASOURCE_SCHEDULE_CHECK_INTERVAL = 60


# Redis key prefix for userinfo cache (fetched from OIDC userinfo endpoint)
REDIS_USERINFO_CACHE_PREFIX = "rag/rbac/userinfo_cache:"
