import json
from typing import Any, Dict, List, Optional
import re
import traceback
from common.utils import get_logger
from common.models.server import QueryResult
from langchain_milvus import Milvus
from common.models.rag import valid_metadata_keys, valid_metadata_keys_with_types

logger = get_logger(__name__)


class VectorDBQueryService:
  def __init__(self, vector_db: Milvus):
    self.vector_db = vector_db
    # Build a type lookup from DocumentMetadata fields for filter coercion
    self._field_types: Dict[str, str] = {entry["key"]: entry["type"] for entry in valid_metadata_keys_with_types()}

  def _coerce_filter_values(self, filters: Dict[str, Any]) -> Dict[str, Any]:
    """
    Coerce filter values to their expected types based on DocumentMetadata field definitions.
    This handles the case where the UI sends string "true"/"false" for boolean fields.
    """
    coerced = {}
    for key, value in filters.items():
      expected_type = self._field_types.get(key)
      if expected_type == "bool" and isinstance(value, str):
        if value.lower() in ("true", "1", "yes"):
          coerced[key] = True
        elif value.lower() in ("false", "0", "no"):
          coerced[key] = False
        else:
          coerced[key] = value  # leave as-is, validation will catch it
      elif expected_type == "int" and isinstance(value, str):
        try:
          coerced[key] = int(value)
        except ValueError:
          coerced[key] = value  # leave as-is, validation will catch it
      else:
        coerced[key] = value
    return coerced

  def _is_valid_filter_key(self, filter_name: str, valid_filter_keys: List[str]) -> bool:
    """
    Check if a filter key is valid.
    Allows top-level DocumentMetadata fields and nested metadata.* keys.
    """
    # Allow top-level fields
    if filter_name in valid_filter_keys:
      return True
    # Allow nested metadata fields (e.g., metadata.structured_entity_type)
    if filter_name.startswith("metadata."):
      nested_key = filter_name[9:]  # Remove "metadata." prefix
      # Validate nested key format (alphanumeric, underscores, no special chars for security)
      if re.match(r"^[a-zA-Z_][a-zA-Z0-9_]*$", nested_key):
        return True
    return False

  def _to_milvus_field_name(self, filter_name: str) -> str:
    """
    Convert filter key to Milvus field reference.
    For nested metadata fields, converts to JSON access syntax.
    e.g., metadata.structured_entity_type -> metadata["structured_entity_type"]
    """
    if filter_name.startswith("metadata."):
      nested_key = filter_name[9:]  # Remove "metadata." prefix
      return f'metadata["{nested_key}"]'
    return filter_name

  async def validate_filter_keys(self, filters: Dict[str, "str | bool | List[str]"]) -> None:
    """Validate filter keys and values"""
    valid_filter_keys = valid_metadata_keys()
    for filter_name, filter_value in filters.items():
      if not self._is_valid_filter_key(filter_name, valid_filter_keys):
        logger.warning(f"Invalid filter key: {filter_name}")
        raise ValueError(f"Invalid filter key: {filter_name}, must be one of {valid_filter_keys} or metadata.<key>")

      if isinstance(filter_value, list):
        if not all(isinstance(v, str) for v in filter_value):
          raise ValueError(f"Invalid filter value for {filter_name}: list values must all be strings")
      elif not isinstance(filter_value, str) and not isinstance(filter_value, bool):
        logger.warning(f"Invalid filter value for {filter_name}: {filter_value}, must be a string, boolean, or list of strings")
        raise ValueError(f"Invalid filter value for {filter_name}: {filter_value}, must be a string, boolean, or list of strings")

  @staticmethod
  def _quote_string(value: str) -> str:
    """Return a Milvus string literal without permitting expression injection."""
    return json.dumps(value, ensure_ascii=False)

  async def build_filter_expression(
    self,
    filters: Optional[Dict[str, "str | bool | List[str]"]],
  ) -> Optional[str]:
    """Validate filters and compile them to a safe Milvus expression."""
    if not filters:
      return None

    filters = self._coerce_filter_values(filters)
    await self.validate_filter_keys(filters)

    filter_expr_parts: List[str] = []
    for key, value in filters.items():
      milvus_field = self._to_milvus_field_name(key)
      if isinstance(value, bool):
        filter_expr_parts.append(f"{milvus_field} == {str(value).lower()}")
      elif isinstance(value, list):
        exact = [v for v in value if not v.endswith("*")]
        prefixes = [v[:-1] for v in value if v.endswith("*")]
        parts: List[str] = []
        if exact:
          values_str = ", ".join(self._quote_string(v) for v in exact)
          parts.append(f"{milvus_field} in [{values_str}]")
        for prefix in prefixes:
          parts.append(f"{milvus_field} like {self._quote_string(f'{prefix}%')}")
        if not parts:
          # An empty intersection is an explicit deny, never a missing filter.
          parts.append(f"{milvus_field} in [{self._quote_string('__noresults__')}]")
        filter_expr_parts.append(parts[0] if len(parts) == 1 else f"({' or '.join(parts)})")
      else:
        filter_expr_parts.append(f"{milvus_field} == {self._quote_string(value)}")
    return " AND ".join(filter_expr_parts)

  async def query(self, query: str, filters: Optional[Dict[str, "str | bool | List[str]"]] = None, limit: int = 10, ranker: str = "", ranker_params: Optional[Dict[str, Any]] = None) -> List[QueryResult]:
    """
    Query the vector database with optional filters and ranking.
    :param query: The query string.
    :param filters: Optional filters to apply. Supports top-level DocumentMetadata fields
                    (e.g., datasource_id, document_type) and nested metadata fields
                    (e.g., metadata.structured_entity_type).
    :param limit: Number of results to return.
    :param ranker: Type of ranker to use ('weighted', 'recency', etc.).
    :param ranker_params: Parameters for the ranker.
    :return: QueryResults containing the results and their scores.
    """

    filter_expr = await self.build_filter_expression(filters)

    logger.info(f"Searching docs vector db with filters - {filter_expr}, query: {query}")
    try:
      results = await self.vector_db.asimilarity_search_with_score(query, k=limit, ranker_type=ranker, ranker_params=ranker_params, expr=filter_expr)
    except Exception as e:
      logger.error(traceback.format_exc())
      logger.error(f"Error querying docs vector db: {e}")
      return []

    # Format results for response
    query_results: List[QueryResult] = []
    for doc, score in results:
      query_results.append(QueryResult(document=doc, score=score))
    return query_results
