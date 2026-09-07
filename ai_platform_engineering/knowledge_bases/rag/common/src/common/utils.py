import ipaddress
import json
import logging
import os
import re
import socket
from json import JSONEncoder
import traceback
import asyncio
import hashlib
import time
import uuid
from typing import Optional
from urllib.parse import urlparse
from common.models.rag import StructuredEntity

DURATION_DAY = 60 * 60 * 24
DURATION_HOUR = 60 * 60
DURATION_MINUTE = 60

# Buffer factor for fresh_until calculation: fresh_until = now + (reload_interval * buffer)
# 1.5x provides grace period for ingestion delays while ensuring cleanup happens reasonably soon after missed reloads
FRESH_UNTIL_BUFFER_FACTOR = float(os.getenv("FRESH_UNTIL_BUFFER_FACTOR", "1.5"))


class ObjEncoder(JSONEncoder):
  def __init__(self, *args, **argv):
    super().__init__(*args, **argv)
    self.proc_objs = []

  def default(self, o):
    # Check for circular reference
    obj_id = id(o)
    if obj_id in self.proc_objs:
      return f"<CircularRef:{type(o).__name__}>"

    if isinstance(o, set):
      return list(o)
    elif isinstance(o, frozenset):
      return list(o)
    elif isinstance(o, tuple):
      return list(o)
    else:
      try:
        # Add object to processed list before processing its attributes
        self.proc_objs.append(obj_id)
        result = o.__dict__
        # Remove object from processed list after processing
        self.proc_objs.remove(obj_id)
        return result
      except AttributeError:
        return str(o)


def json_encode(obj, **kwargs):
  """
  Encodes an object to JSON using the custom encoder.
  """
  return json.dumps(remove_circular_refs(obj), cls=ObjEncoder, check_circular=False, **kwargs)


def remove_circular_refs(ob, _seen=None):
  if _seen is None:
    _seen = set()
  if id(ob) in _seen:
    return f"<CircularRef:{type(ob).__name__}>"
  _seen.add(id(ob))
  try:
    if isinstance(ob, dict):
      res = {remove_circular_refs(key, _seen): remove_circular_refs(value, _seen) for key, value in ob.items()}
    elif isinstance(ob, list):
      res = [remove_circular_refs(v, _seen) for v in ob]
    elif isinstance(ob, tuple):
      res = tuple(remove_circular_refs(v, _seen) for v in ob)
    elif isinstance(ob, set):
      res = {remove_circular_refs(v, _seen) for v in ob}
    elif isinstance(ob, frozenset):
      res = frozenset(remove_circular_refs(v, _seen) for v in ob)
    elif hasattr(ob, "__dict__"):
      # For objects with __dict__, convert to dict to avoid constructor issues
      res = {key: remove_circular_refs(value, _seen) for key, value in ob.__dict__.items()}
    else:
      # For all other types (primitives, objects, etc.), return as-is
      res = ob
  except Exception:
    # If any error occurs during processing, return string representation
    res = str(ob)
  finally:
    _seen.remove(id(ob))

  return res


# assisted-by claude code claude-sonnet-4-6
def _is_publicly_routable_ip(ip_address: str) -> bool:
  addr = ipaddress.ip_address(ip_address)
  return addr.is_global and not (
    addr.is_loopback
    or addr.is_link_local
    or addr.is_multicast
    or addr.is_private
    or addr.is_reserved
    or addr.is_unspecified
  )


def _resolve_host_addresses(hostname: str) -> list[str]:
  try:
    return [str(ipaddress.ip_address(hostname))]
  except ValueError:
    pass

  results = socket.getaddrinfo(hostname, None, type=socket.SOCK_STREAM)
  return [sockaddr[0] for _family, _type, _proto, _canonname, sockaddr in results]


def is_publicly_routable_host(hostname: str) -> tuple[bool, str]:
  if not hostname:
    return False, "missing hostname"

  try:
    addresses = _resolve_host_addresses(hostname)
  except (socket.gaierror, OSError) as e:
    return False, f"hostname could not be resolved: {e}"

  if not addresses:
    return False, "hostname did not resolve to any address"

  for address in addresses:
    try:
      if not _is_publicly_routable_ip(address):
        return False, f"{address} is not publicly routable"
    except ValueError:
      return False, f"{address} is not a valid IP address"

  return True, ""


def is_publicly_routable_url(url: str) -> tuple[bool, str]:
  parsed = urlparse(url)
  if parsed.scheme not in ("http", "https"):
    return False, f"unsupported URL scheme: {parsed.scheme}"
  if not parsed.netloc:
    return False, "missing domain name"
  return is_publicly_routable_host(parsed.hostname or "")


def sanitize_url(url: str, allow_non_public_urls: bool = False) -> str:
  url = url.strip()
  parsed = urlparse(url)  # Parse the URL
  if not parsed.scheme:  # Add default scheme if missing
    parsed = urlparse("https://" + url)
  if parsed.scheme not in ("http", "https"):  # Validate scheme is http or https
    raise ValueError(f"Invalid URL scheme. Only HTTP and HTTPS are supported, got: {parsed.scheme}")
  if not parsed.netloc:  # Validate that we have a netloc (domain)
    raise ValueError("Invalid URL: missing domain name")
  if not allow_non_public_urls:
    hostname = parsed.hostname or ""
    is_safe, reason = is_publicly_routable_host(hostname)
    if not is_safe:
      raise ValueError(f"Invalid URL: hostname '{hostname}' must resolve only to publicly routable IP addresses: {reason}")
  url = parsed.geturl()  # Reconstruct the URL to ensure it's properly formatted
  return url


def generate_datasource_id_from_url(url: str) -> str:
  """Generate a unique source ID based on URL"""
  source_hash = hashlib.md5(url.encode()).hexdigest()[:12]
  # Replace non-alphanumeric characters with underscore
  clean_url = "".join(c if c.isalnum() else "_" for c in url)
  return f"src_{clean_url}_{source_hash}"


def generate_confluence_datasource_id(
  confluence_url: str,
  space_key: str,
  page_id: Optional[str] = None,
) -> str:
  """Generate a stable ID for a Confluence space or page-rooted source.

  Legacy environment configuration models an entire space as one datasource
  and therefore omits ``page_id``. UI-created sources are rooted at a page;
  including that immutable page ID lets one space contain multiple independent
  datasources without changing scheduled reload or stale-chunk replacement.
  """
  domain = urlparse(confluence_url).netloc.replace(".", "_").replace("-", "_")
  datasource_id = f"src_confluence___{domain}__{space_key}"
  if not page_id:
    # Keep whole-space IDs stable for legacy environment configuration. These
    # sources are handled by the one-time import compatibility path.
    return datasource_id

  raw_id = f"{datasource_id}__{page_id}"
  safe_id = re.sub(r"[^A-Za-z0-9._~@|*+=,/-]", "_", raw_id)
  if len(safe_id) <= 192:
    return safe_id
  suffix = hashlib.sha256(raw_id.encode()).hexdigest()[:12]
  return f"{safe_id[:179]}_{suffix}"


def derive_friendly_name_from_url(url: str, max_length: int = 64) -> str:
  """Derive a short, human-readable display label for a URL-based datasource.

  Strips scheme, collapses long paths to host + first meaningful path segment,
  and caps total length. NEVER used as an authorization key — see
  ``DataSourceInfo.name`` for semantics.

  Examples:
      https://cnoe.io/ai-platform-engineering/      -> "cnoe.io / ai-platform-engineering"
      https://github.com/owner/repo/tree/main/docs  -> "github.com / owner/repo"
      https://example.com                           -> "example.com"
  """
  try:
    parsed = urlparse(url.strip())
  except Exception:
    return url[:max_length]
  host = (parsed.netloc or "").lower()
  if not host:
    return url[:max_length]
  segments = [s for s in (parsed.path or "").split("/") if s]
  if not segments:
    label = host
  elif len(segments) == 1:
    label = f"{host} / {segments[0]}"
  else:
    label = f"{host} / {segments[0]}/{segments[1]}"
  if len(label) > max_length:
    label = label[: max_length - 1] + "\u2026"
  return label


def derive_friendly_name(
  *,
  url: Optional[str] = None,
  source_type: Optional[str] = None,
  space_key: Optional[str] = None,
  project_key: Optional[str] = None,
  channel_name: Optional[str] = None,
  repo: Optional[str] = None,
  fallback: Optional[str] = None,
  max_length: int = 64,
) -> str:
  """Single entry-point for ingestors to derive a display label.

  Prefers the most specific source-type signal available; falls back to the
  URL-derived label, then to ``fallback`` (typically the datasource_id).
  """
  if source_type:
    st = source_type.lower()
    if st in ("confluence", "confluence_space") and space_key:
      return (f"Confluence: {space_key}")[:max_length]
    if st in ("jira", "jira_project") and project_key:
      return (f"Jira: {project_key}")[:max_length]
    if st == "slack" and channel_name:
      return (f"Slack: #{channel_name.lstrip('#')}")[:max_length]
    if st == "github" and repo:
      return (f"GitHub: {repo}")[:max_length]
  if url:
    return derive_friendly_name_from_url(url, max_length=max_length)
  if fallback:
    return fallback[:max_length]
  return "untitled-datasource"


def generate_document_id_from_url(datasource_id: str, url: str) -> str:
  """Generate a unique document ID based on datasource ID and URL"""
  url_hash = hashlib.md5(url.encode()).hexdigest()[:12]
  return f"{datasource_id}_doc_{url_hash}"


class CustomFormatter(logging.Formatter):
  """
  Custom formatter for logging
  """

  grey = "\x1b[38;20m"
  yellow = "\x1b[33;20m"
  red = "\x1b[31;20m"
  bold_red = "\x1b[31;1m"
  reset = "\x1b[0m"
  _format = "%(asctime)s - [%(name)s] %(levelname)s - %(message)s (%(filename)s:%(lineno)d)"
  FORMATS = {logging.DEBUG: grey + _format + reset, logging.INFO: grey + _format + reset, logging.WARNING: yellow + _format + reset, logging.ERROR: red + _format + reset, logging.CRITICAL: bold_red + _format + reset}

  def format(self, record):
    log_fmt = self.FORMATS.get(record.levelno)
    formatter = logging.Formatter(log_fmt)
    return formatter.format(record)


def get_logger(name) -> logging.Logger:
  """
  Returns a logger with the given name and custom formatter
  """
  logger = logging.getLogger("rag")
  logger.propagate = False
  logger = logging.getLogger(f"rag.{name}")
  logger.setLevel(os.getenv("LOG_LEVEL", "INFO").upper())

  # Only add handler if it doesn't already exist (prevents duplicate logs)
  if not logger.handlers:
    formatter = CustomFormatter()
    handler = logging.StreamHandler()
    handler.setFormatter(formatter)
    logger.addHandler(handler)
  return logger


async def gather(n: int, *coros: asyncio.Future, logger: logging.Logger):
  """
  Gathers (waits for) a list of coroutines with a limit on the number of concurrent executions.
  """
  semaphore = asyncio.Semaphore(n)

  async def sem_coro(index, coro):
    async with semaphore:
      try:
        await coro
      except Exception as e:
        logger.error(traceback.format_exc())
        logger.error(f"Error in task {index}: {e}")

      logger.debug(f"Finished task {index}")
      return

  logger.debug(f"Starting {len(coros)} tasks with {n} concurrent tasks")
  await asyncio.gather(*(sem_coro(index, coro) for index, coro in enumerate(coros)))
  logger.info(f"All {len(coros)} tasks finished")


def hash_entity_properties(entity: StructuredEntity):
  """
  Hashes the properties of an entity
  """
  entity_dict = {}
  for key, val in entity.all_properties.items():
    if key[0] == "_":
      continue
    if val == "":
      continue
    entity_dict[key] = val
  return hash_dict(entity_dict)


def hash_dict(d: dict) -> str:
  """
  Hashes a dictionary object into a string.
  """
  h = hashlib.new("md5")
  encoded = json.dumps(d, sort_keys=True, cls=ObjEncoder).encode()
  h.update(encoded)
  return str(h.hexdigest())


def get_fresh_until(reload_interval: int) -> int:
  """
  Calculate fresh_until timestamp based on reload interval.

  The fresh_until timestamp determines when data should be considered stale
  and eligible for cleanup. It's calculated as: now + (reload_interval * buffer_factor)

  Args:
      reload_interval: Reload interval in seconds. Must be > 0.

  Returns:
      Epoch timestamp when data should be considered stale.

  Examples:
      - reload_interval=6h  -> fresh_until = now + 9h  (with 1.5x buffer)
      - reload_interval=24h -> fresh_until = now + 36h (with 1.5x buffer)
  """
  if reload_interval <= 0:
    raise ValueError(f"reload_interval must be positive, got {reload_interval}")
  return int(time.time()) + int(reload_interval * FRESH_UNTIL_BUFFER_FACTOR)


def get_uuid():
  """
  Returns a random UUID.
  """
  return str(uuid.uuid4())


def retry_function(func, retries=20, delay=5, *args, **kwargs):
  """
  Tries to execute the given function up to `max_retries` times.
  If the function raises an exception, it waits `delay` seconds before retrying.

  :param func: The function to execute.
  :param retries: Maximum number of retry attempts.
  :param delay: Delay between retries in seconds.
  :param args: Positional arguments for the function.
  :param kwargs: Keyword arguments for the function.
  :raises: The last exception encountered if the function fails all attempts.
  """
  attempt = 0
  while attempt < retries:
    try:
      return func(*args, **kwargs)
    except Exception as e:
      attempt += 1
      logging.warning(f"Attempt {attempt} failed: {e}")
      logging.error(f"Cool down of {delay} seconds, before retrying...")
      if attempt >= retries:
        logging.error(f"Function '{func.__name__}' failed after {retries} attempts.")
        raise e
      for i in range(delay):
        logging.info(f"Retrying '{func.__name__}' in {delay - i} seconds...")
        try:
          time.sleep(1)
        except KeyboardInterrupt:
          logging.info("Keyboard interrupt received, stopping retry...")
          exit(0)


async def retry_function_async(func, retries=20, delay=5, *args, **kwargs):
  """
  Async version: Tries to execute the given async function up to `max_retries` times.
  If the function raises an exception, it waits `delay` seconds before retrying.

  :param func: The async function to execute.
  :param retries: Maximum number of retry attempts.
  :param delay: Delay between retries in seconds.
  :param args: Positional arguments for the function.
  :param kwargs: Keyword arguments for the function.
  :raises: The last exception encountered if the function fails all attempts.
  """
  attempt = 0
  func_name = getattr(func, "__name__", str(func))

  while attempt < retries:
    try:
      return await func(*args, **kwargs)
    except Exception as e:
      attempt += 1
      logging.warning(f"Attempt {attempt} failed: {e}")
      logging.error(f"Cool down of {delay} seconds, before retrying...")
      if attempt >= retries:
        logging.error(f"Function '{func_name}' failed after {retries} attempts.")
        raise e
      for i in range(delay):
        logging.info(f"Retrying '{func_name}' in {delay - i} seconds...")
        try:
          await asyncio.sleep(1)
        except asyncio.CancelledError:
          logging.info("Task cancelled, stopping retry...")
          raise


def format_entity_type_for_display(entity_type: str) -> list[str]:
  """
  Generate all possible variations of a CamelCase entity type for search/matching.

  This method generates multiple variations by splitting at clear, natural word boundaries only.
  If there are no clear split points, it returns just the original string.

  Examples:
  - AwsAccount -> ['AwsAccount', 'Aws Account']
  - AwsEksCluster -> ['AwsEksCluster', 'Aws Eks Cluster', 'Aws EksCluster', 'AwsEks Cluster']
  - AwsS3Bucket -> ['AwsS3Bucket', 'Aws S3 Bucket', 'Aws S3Bucket', 'AwsS3 Bucket']
  - BackstageComponent -> ['BackstageComponent', 'Backstage Component']
  - K8sNamespace -> ['K8sNamespace', 'K8s Namespace']
  - EC2Instance -> ['EC2Instance', 'EC2 Instance']

  :param entity_type: The CamelCase entity type string to format
  :return: A list of possible formatted variations
  """
  if not entity_type:
    return [entity_type]

  # Always include the original
  variations = {entity_type}

  # Find all clear, natural split points (positions where we can insert a space)
  split_points = []

  for i in range(1, len(entity_type)):
    char = entity_type[i]
    prev_char = entity_type[i - 1]

    # Split before uppercase letter that follows a lowercase letter (e.g., "Aws|Account")
    if char.isupper() and prev_char.islower():
      split_points.append(i)
    # Split before uppercase letter followed by lowercase when previous is uppercase
    # (e.g., "AWS|Account" - clear word boundary)
    elif i < len(entity_type) - 1 and char.isupper() and prev_char.isupper() and entity_type[i + 1].islower():
      split_points.append(i)
    # Split before uppercase letter after a digit (e.g., "S3|Bucket", "K8s|Namespace")
    elif char.isalpha() and char.isupper() and prev_char.isdigit():
      split_points.append(i)

  if not split_points:
    # No clear split points, return original only
    return [entity_type]

  # Generate combinations of splits
  from itertools import combinations

  # Add the fully split version (all split points)
  parts = []
  last_idx = 0
  for split_idx in split_points:
    parts.append(entity_type[last_idx:split_idx])
    last_idx = split_idx
  parts.append(entity_type[last_idx:])
  variations.add(" ".join(parts))

  # Generate partial splits (useful for intermediate variations)
  # For performance, limit combinations to avoid explosion
  max_combinations = min(len(split_points), 4)

  for r in range(1, len(split_points)):
    if r > max_combinations:
      break
    for combo in combinations(split_points, r):
      parts = []
      last_idx = 0
      for split_idx in sorted(combo):
        parts.append(entity_type[last_idx:split_idx])
        last_idx = split_idx
      parts.append(entity_type[last_idx:])
      variations.add(" ".join(parts))

  # Sort variations by number of spaces (original first, then increasing complexity)
  sorted_variations = sorted(variations, key=lambda x: (x.count(" "), x))

  return sorted_variations


def flatten_dict(d: dict, wildcard_index=True, preserve_list_of_dicts=False) -> dict[str, str]:
  """
  Flattens a nested dictionary, list, or set.
  For lists and sets, the index will be used as the key.
  :param d: The dictionary to flatten.
  :param wildcard_index: Whether to use a wildcard index for lists and sets. If True, all indices will be replaced with `[*]`. Values will be stored as a list.
  :param preserve_list_of_dicts: If True, lists containing dictionaries are preserved as-is (not flattened).
  :return: A flattened dictionary.
  """

  def _flatten(obj, parent_key=""):
    items = []
    if isinstance(obj, dict):
      for k, v in obj.items():
        new_key = f"{parent_key}.{k}" if parent_key else k
        items.extend(_flatten(v, new_key).items())
    elif isinstance(obj, (list, set)):
      # Check if we should preserve this list of dicts
      if preserve_list_of_dicts and isinstance(obj, list) and len(obj) > 0 and isinstance(obj[0], dict):
        # Keep list of dicts as-is
        items.append((parent_key, obj))
      elif wildcard_index:
        new_key = f"{parent_key}.[*]" if parent_key else "[*]"
        vals = []
        for i, v in enumerate(obj):
          if isinstance(v, (dict, list, set)):
            items.extend(_flatten(v, new_key).items())
          else:
            if parent_key:
              new_key = f"{parent_key}.[*]"
            else:
              new_key = "[*]"
            vals.append(v)
        if len(vals) > 0:
          items.append((new_key, vals))
      else:
        for i, v in enumerate(obj):
          new_key = f"{parent_key}.[{i}]" if parent_key else f"[{i}]"
          items.extend(_flatten(v, new_key).items())
    else:
      items.append((parent_key, obj))

    # Collapse items into flattened dictionary
    if wildcard_index:  # preserve duplicate keys by using a list
      result_dict = {}
      for k, v in items:
        if k in result_dict:
          # If the key already exists, append the value to the list
          if isinstance(result_dict[k], list):
            if isinstance(v, list):
              result_dict[k].extend(v)
            else:
              result_dict[k].append(v)
          else:
            if isinstance(v, list):
              result_dict[k] = [result_dict[k]] + v
            else:
              result_dict[k] = [result_dict[k], v]
        else:
          # If the key does not exist, add it to the dictionary
          result_dict[k] = v
      return result_dict
    else:
      return dict(items)

  return _flatten(d)


def filter_nested_dict(data, ignore_field_list, prefix: str = ""):
  """
  Filter out ignored fields from a nested dictionary structure.
  This preserves the nested structure while removing fields that match patterns in ignore_field_list.

  Args:
      data: Nested dictionary or value to filter
      ignore_field_list: List of field path prefixes to ignore (e.g., ["metadata.managedFields", "status"])
      prefix: Current path prefix (used for recursion)

  Returns:
      Filtered data structure with ignored fields removed

  Example:
      data = {"metadata": {"name": "foo", "managedFields": [...]}, "status": {...}}
      ignore_list = ["metadata.managedFields", "status"]
      result = filter_nested_dict(data, ignore_list)
      # result: {"metadata": {"name": "foo"}}
  """

  def should_ignore_field(field_path: str) -> bool:
    """Check if a field path matches any ignore pattern"""
    for ignore_pattern in ignore_field_list:
      if field_path.startswith(ignore_pattern):
        return True
    return False

  if isinstance(data, dict):
    filtered = {}
    for key, value in data.items():
      # Build the full path for this key
      current_path = f"{prefix}.{key}" if prefix else key

      # Check if this path should be ignored
      if should_ignore_field(current_path):
        logging.debug(f"Ignoring field: {current_path}")
        continue

      # Recursively filter nested structures
      filtered[key] = filter_nested_dict(value, ignore_field_list, current_path)
    return filtered
  elif isinstance(data, list):
    # Filter each item in the list
    return [filter_nested_dict(item, ignore_field_list, prefix) for item in data]
  else:
    # Return primitive values as-is
    return data


def runforever(func):
  """
  Decorator to run a function forever.
  """

  async def wrapper(*args, **kwargs):
    while True:
      try:
        await func(*args, **kwargs)
      except Exception as e:
        traceback.print_exc()
        logging.error(f"Error: {e}")
        logging.error(f"Cool down of 10 seconds, before restarting function '{func.__name__}'...")
        await asyncio.sleep(10)

  return wrapper


# if __name__ == "__main__":
#     # Example usage
#     example_dict = {
#         "a": 1,
#         "b": [2, 3, 4],
#         "d": {
#             "e": 5,
#             "f": [6, 7]
#             },
#         "x" : [
#             {"y": 11, "z": 12},
#             {"y": 13, "z": 14},
#             {"y": 15, "z": 16},
#             {"y": 13, "z": 12}
#         ],
#         "c": [{"d": 5, "e": [6, 7]},
#               {"d": 8, "e": [9, 10]},
#               {"d": 8, "e": [11, 12]}
#               ],
#         "m": [{"n": 5, "o": [6, {"p": 7}]},
#               {"n": 8, "o": [9, {"p": 10}]},
#               {"n": 8, "o": [11, {"p": 12}]}
#               ],
#         "g": [2, 3, 4, {"h": 8, "i": [9, 10]}],
#     }

#     flattened = flatten_dict(example_dict,  wildcard_index=False)
#     print(f"Flattened dict: {json_encode(flattened, indent=2)}")
#     flattened = flatten_dict(example_dict)
#     print(f"Flattened dict: {json_encode(flattened, indent=2)}")
