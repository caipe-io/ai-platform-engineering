# This file contains metadata storage class for the RAG server
import json
from typing import Optional, List
from common.mongo_storage import MongoStorage
from common.models.rag import DataSourceInfo, IngestorInfo, MCPToolConfig, MCPBuiltinToolsConfig
from common.constants import (
  REDIS_DATASOURCE_PREFIX,
  REDIS_DATASOURCE_DOCUMENTS_PREFIX,
  REDIS_INGESTOR_PREFIX,
  REDIS_MCP_TOOL_CONFIG_PREFIX,
  REDIS_MCP_BUILTIN_CONFIG_KEY,
)


class MetadataStorage:
  """
  Metadata storage class for the RAG server.
  """

  def __init__(self, redis_client: MongoStorage):
    self.redis_client = redis_client

  async def setup(self):
    """Initialize the metadata storage"""
    # Create indexes before serving requests
    await self.redis_client.setup()

  async def store_datasource_info(self, source_info: DataSourceInfo, ttl: int = 0):
    """Store datasource information in MongoDB"""
    if ttl > 0:
      await self.redis_client.setex(f"{REDIS_DATASOURCE_PREFIX}{source_info.datasource_id}", ttl, json.dumps(source_info.model_dump(), default=str))
    else:
      await self.redis_client.set(f"{REDIS_DATASOURCE_PREFIX}{source_info.datasource_id}", json.dumps(source_info.model_dump(), default=str))

  async def get_datasource_info(self, datasource_id: str) -> Optional[DataSourceInfo]:
    """Retrieve datasource information from MongoDB"""
    source_data = await self.redis_client.get(f"{REDIS_DATASOURCE_PREFIX}{datasource_id}")
    if source_data:
      data = json.loads(source_data)
      return DataSourceInfo(**data)
    return None

  async def fetch_all_datasource_ids(self) -> List[str]:
    """List all stored datasource IDs"""
    keys = await self.redis_client.keys(f"{REDIS_DATASOURCE_PREFIX}*")
    return [key.replace(REDIS_DATASOURCE_PREFIX, "") for key in keys]

  async def fetch_all_datasource_info(self) -> List[DataSourceInfo]:
    """List all stored datasource information"""
    keys = await self.redis_client.keys(f"{REDIS_DATASOURCE_PREFIX}*")
    result = []
    for key in keys:
      raw = await self.redis_client.get(key)
      if raw:
        result.append(DataSourceInfo(**json.loads(raw)))
    return result

  # Graph ingestor management methods
  async def store_ingestor_info(self, ingestor_info: IngestorInfo, ttl: int = 0):
    """Store ingestor information in MongoDB"""
    if ttl > 0:
      await self.redis_client.setex(f"{REDIS_INGESTOR_PREFIX}{ingestor_info.ingestor_id}", ttl, json.dumps(ingestor_info.model_dump(), default=str))
    else:
      await self.redis_client.set(f"{REDIS_INGESTOR_PREFIX}{ingestor_info.ingestor_id}", json.dumps(ingestor_info.model_dump(), default=str))

  async def get_ingestor_info(self, ingestor_id: str) -> Optional[IngestorInfo]:
    """Retrieve ingestor information from MongoDB"""
    ingestor_data = await self.redis_client.get(f"{REDIS_INGESTOR_PREFIX}{ingestor_id}")
    if ingestor_data:
      data = json.loads(ingestor_data)
      return IngestorInfo(**data)
    return None

  async def fetch_all_ingestor_ids(self) -> List[str]:
    """List all stored ingestor IDs"""
    keys = await self.redis_client.keys(f"{REDIS_INGESTOR_PREFIX}*")
    return [key.replace(REDIS_INGESTOR_PREFIX, "") for key in keys]

  async def fetch_all_ingestor_info(self) -> List[IngestorInfo]:
    """List all stored ingestor information"""
    keys = await self.redis_client.keys(f"{REDIS_INGESTOR_PREFIX}*")
    result = []
    for key in keys:
      ingestor_data = await self.redis_client.get(key)
      if ingestor_data:
        data = json.loads(ingestor_data)
        result.append(IngestorInfo(**data))
    return result

  async def delete_ingestor_info(self, ingestor_id: str):
    """Delete ingestor information from MongoDB"""
    await self.redis_client.delete(f"{REDIS_INGESTOR_PREFIX}{ingestor_id}")

  # Datasource cleanup functions
  async def delete_datasource_info(self, datasource_id: str):
    """Clear all data for a specific source"""
    keys = []
    keys.append(f"{REDIS_DATASOURCE_PREFIX}{datasource_id}")
    keys.extend(await self.redis_client.keys(f"{REDIS_DATASOURCE_DOCUMENTS_PREFIX}{datasource_id}*"))
    if keys:
      await self.redis_client.delete(*keys)

  # ============================================================================
  # MCP tool config methods
  # ============================================================================

  async def store_mcp_tool_config(self, config: MCPToolConfig):
    """Store an MCP tool configuration in MongoDB."""
    await self.redis_client.set(f"{REDIS_MCP_TOOL_CONFIG_PREFIX}{config.tool_id}", json.dumps(config.model_dump(), default=str))

  async def get_mcp_tool_config(self, tool_id: str) -> Optional[MCPToolConfig]:
    """Retrieve an MCP tool configuration from MongoDB."""
    data = await self.redis_client.get(f"{REDIS_MCP_TOOL_CONFIG_PREFIX}{tool_id}")
    if data:
      return MCPToolConfig(**json.loads(data))
    return None

  async def fetch_all_mcp_tool_configs(self) -> List[MCPToolConfig]:
    """List all stored MCP tool configurations."""
    keys = await self.redis_client.keys(f"{REDIS_MCP_TOOL_CONFIG_PREFIX}*")
    result = []
    for key in keys:
      raw = await self.redis_client.get(key)
      if raw:
        result.append(MCPToolConfig(**json.loads(raw)))
    return result

  async def delete_mcp_tool_config(self, tool_id: str):
    """Delete an MCP tool configuration from MongoDB."""
    await self.redis_client.delete(f"{REDIS_MCP_TOOL_CONFIG_PREFIX}{tool_id}")

  async def store_mcp_builtin_config(self, config: MCPBuiltinToolsConfig):
    """Store the built-in MCP tools configuration (fetch/graph enable flags)."""
    await self.redis_client.set(REDIS_MCP_BUILTIN_CONFIG_KEY, json.dumps(config.model_dump(), default=str))

  async def get_mcp_builtin_config(self) -> Optional[MCPBuiltinToolsConfig]:
    """Retrieve the built-in MCP tools configuration."""
    data = await self.redis_client.get(REDIS_MCP_BUILTIN_CONFIG_KEY)
    if data:
      return MCPBuiltinToolsConfig(**json.loads(data))
    return None

  async def clear_all_data(self):
    """Clear RAG metadata"""
    datasource_keys = await self.redis_client.keys(f"{REDIS_DATASOURCE_PREFIX}*")
    relation_keys = await self.redis_client.keys(f"{REDIS_DATASOURCE_DOCUMENTS_PREFIX}*")
    ingestor_keys = await self.redis_client.keys(f"{REDIS_INGESTOR_PREFIX}*")
    mcp_tool_keys = await self.redis_client.keys(f"{REDIS_MCP_TOOL_CONFIG_PREFIX}*")
    mcp_builtin_keys = await self.redis_client.keys(REDIS_MCP_BUILTIN_CONFIG_KEY)

    all_keys = datasource_keys + relation_keys + ingestor_keys + mcp_tool_keys + mcp_builtin_keys
    if all_keys:
      await self.redis_client.delete(*all_keys)
