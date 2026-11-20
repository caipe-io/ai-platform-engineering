"""S3 RAG ingestor.

This first implementation slice defines the configuration and source-selection
helpers used by the S3 ingestor. The full sync path will build on these helpers
to list S3 objects, fetch accepted files, and submit documents to the RAG server.
"""

from __future__ import annotations

import configparser
from dataclasses import dataclass
from fnmatch import fnmatchcase
import hashlib
import os
import asyncio
from pathlib import PurePosixPath
import re
import tempfile
import time
from typing import Any, Iterable, Iterator

import boto3
from common.ingestor_listener import run_standalone_ingestion
from common.ingestor import Client, IngestorBuilder
from common.job_manager import JobStatus
from common.models.rag import DataSourceInfo, DocumentMetadata
import common.utils as utils
from langchain_core.document_loaders import BaseLoader
from langchain_core.documents import Document


DEFAULT_ALLOWED_FILE_PATTERNS = {"*.txt", "*.md", "*.rst", "*.adoc", "*.asciidoc"}
DEFAULT_MAX_FILES_PER_BUCKET = 2000
S3_BUCKETS = os.environ.get("S3_BUCKETS", "")
S3_ALLOWED_FILES_AND_EXTENSIONS = os.environ.get(
    "S3_ALLOWED_FILES_AND_EXTENSIONS", ",".join(sorted(DEFAULT_ALLOWED_FILE_PATTERNS)))
S3_IGNORE_PREFIXES = os.environ.get("S3_IGNORE_PREFIXES", "")
S3_IGNORE_REGEX = os.environ.get("S3_IGNORE_REGEX", "")
S3_MAX_FILES_PER_BUCKET = os.environ.get(
    "S3_MAX_FILES_PER_BUCKET", str(DEFAULT_MAX_FILES_PER_BUCKET))
SYNC_INTERVAL = int(os.getenv("SYNC_INTERVAL", "86400"))
AWS_REGION = os.environ.get("AWS_REGION") or os.environ.get("AWS_DEFAULT_REGION") or "us-east-2"
AWS_ACCOUNT_LIST = os.environ.get("AWS_ACCOUNT_LIST", "")
CROSS_ACCOUNT_ROLE_NAME = os.environ.get("CROSS_ACCOUNT_ROLE_NAME", "caipe-read-only")
LOG_LEVEL = os.environ.get("LOG_LEVEL", "INFO").upper()

logger = utils.get_logger(__name__)


@dataclass(frozen=True)
class BucketSpec:
    """S3 bucket ARN, optional source account, and prefix configured for ingestion."""

    bucket: str
    prefix: str
    account_name: str | None = None
    bucket_arn: str | None = None


@dataclass(frozen=True)
class S3ObjectInfo:
  """Metadata for an S3 object selected for ingestion."""

  bucket: str
  key: str
  prefix: str
  account_name: str | None = None
  etag: str | None = None
  last_modified: Any | None = None
  size: int | None = None

  @property
  def relative_key(self) -> str:
    return self.key[len(self.prefix) :] if self.prefix else self.key

  @property
  def file_name(self) -> str:
    return PurePosixPath(self.key).name

  @property
  def extension(self) -> str:
    return PurePosixPath(self.key).suffix.lower()

  @property
  def s3_uri(self) -> str:
    return f"s3://{self.bucket}/{self.key}"


def _parse_s3_bucket_arn(bucket_arn: str) -> str:
    """Return the bucket name from an S3 bucket ARN."""
    parts = bucket_arn.split(":", 5)
    if len(parts) != 6 or parts[0] != "arn" or parts[2] != "s3":
        raise ValueError(
            "S3_BUCKETS entries must be S3 bucket ARNs like arn:aws:s3:::bucket-name"
        )

    _, _, _, region, account_id, resource = parts
    if region or account_id:
        raise ValueError(
            f"S3_BUCKETS entry must be a bucket ARN with empty region and account fields: {bucket_arn}"
        )

    bucket = resource.strip()
    if not bucket:
        raise ValueError(f"S3_BUCKETS entry is missing a bucket name: {bucket_arn}")
    if "/" in bucket:
        raise ValueError(
            f"S3_BUCKETS entries must be bucket ARNs, not object or prefix ARNs: {bucket_arn}"
        )

    return bucket


def _split_account_qualified_bucket_arn(entry: str) -> tuple[str | None, str]:
    """Split optional ``account_name:arn:aws:s3:::bucket`` entries."""
    if entry.startswith("arn:"):
        return None, entry

    if ":arn:" not in entry:
        raise ValueError(
            "S3_BUCKETS entries must be S3 bucket ARNs, optionally account-qualified "
            "as account_name:arn:aws:s3:::bucket-name"
        )

    account_name, arn_suffix = entry.split(":arn:", 1)
    account_name = account_name.strip()
    if not account_name:
        raise ValueError(f"S3_BUCKETS entry is missing an account name: {entry}")

    return account_name, f"arn:{arn_suffix.strip()}"


def parse_bucket_specs(raw_specs: str) -> list[BucketSpec]:
    """Parse S3_BUCKETS as comma-separated S3 bucket ARNs.

    Prefix selection is intentionally out of scope for the MVP. Every configured
    bucket is scanned from the root and filtered by extension/ignore rules.

    Entries may optionally be account-qualified as
    ``account_name:arn:aws:s3:::bucket``. The account name must match an
    ``AWS_ACCOUNT_LIST`` entry so the ingestor can use the same cross-account
    assume-role profile behavior as the AWS ingestor.
    """
    specs: list[BucketSpec] = []

    for raw_entry in raw_specs.split(","):
        entry = raw_entry.strip()
        if not entry:
            continue

        account_name, bucket_arn = _split_account_qualified_bucket_arn(entry)
        bucket = _parse_s3_bucket_arn(bucket_arn)
        prefix = ""
        specs.append(
            BucketSpec(
                bucket=bucket,
                prefix=prefix,
                account_name=account_name,
                bucket_arn=bucket_arn,
            )
        )

    if not specs:
        raise ValueError(
            "S3_BUCKETS must include at least one S3 bucket ARN")

    return specs


def get_bucket_specs() -> list[BucketSpec]:
    """Return configured S3 bucket specs from S3_BUCKETS."""
    return parse_bucket_specs(S3_BUCKETS)


def parse_account_list() -> list[dict[str, str]]:
  """Parse AWS_ACCOUNT_LIST as ``name:account_id`` entries."""
  if not AWS_ACCOUNT_LIST:
    return []

  accounts: list[dict[str, str]] = []
  for entry in AWS_ACCOUNT_LIST.split(","):
    entry = entry.strip()
    if not entry:
      continue
    if ":" in entry:
      name, account_id = entry.split(":", 1)
      accounts.append({"name": name.strip(), "id": account_id.strip()})
    else:
      accounts.append({"name": entry, "id": entry})

  return accounts


def setup_aws_profiles(accounts: list[dict[str, str]]) -> None:
  """Generate boto3 profiles for AWS_ACCOUNT_LIST entries without direct credentials."""
  if not accounts:
    return

  existing_profiles: set[str] = set()
  credentials_file = os.path.expanduser("~/.aws/credentials")
  if os.path.exists(credentials_file):
    creds_parser = configparser.ConfigParser()
    creds_parser.read(credentials_file)
    existing_profiles = set(creds_parser.sections())

  needs_config = [account for account in accounts if account["name"] not in existing_profiles]
  if not needs_config:
    logger.info(f"All {len(accounts)} S3 account profiles have direct credentials")
    return

  aws_config_dir = tempfile.mkdtemp(prefix="s3_ingestor_aws_config_")
  aws_config_file = os.path.join(aws_config_dir, "config")
  os.environ["AWS_CONFIG_FILE"] = aws_config_file

  profile_sections = ["# AUTO-GENERATED PROFILES FROM S3 AWS_ACCOUNT_LIST"]
  profile_sections.append("# Regenerated at ingestor startup - do not edit manually\n")
  for account in needs_config:
    profile_sections.append(
      f"""[profile {account["name"]}]
role_arn = arn:aws:iam::{account["id"]}:role/{CROSS_ACCOUNT_ROLE_NAME}
credential_source = Environment
"""
    )

  with open(aws_config_file, "w") as config_file:
    config_file.write("\n".join(profile_sections))

  logger.info(
    f"Generated S3 AWS config for {len(needs_config)} accounts needing role assumption: "
    f"{[account['name'] for account in needs_config]}"
  )


def validate_bucket_account_specs(
  bucket_specs: list[BucketSpec],
  accounts: list[dict[str, str]],
) -> None:
  """Validate that account-qualified buckets match configured AWS accounts."""
  if not accounts:
    return

  account_names = {account["name"] for account in accounts}
  unqualified = [spec.bucket for spec in bucket_specs if spec.account_name is None]
  if unqualified:
    raise ValueError(
      "S3_BUCKETS entries must include account names when AWS_ACCOUNT_LIST is set: "
      f"{unqualified}"
    )

  unknown_accounts = sorted(
    {spec.account_name for spec in bucket_specs if spec.account_name not in account_names}
  )
  if unknown_accounts:
    raise ValueError(
      "S3_BUCKETS references accounts not present in AWS_ACCOUNT_LIST: "
      f"{unknown_accounts}"
    )


def _normalize_allowed_file_pattern(pattern: str) -> str:
    """Normalize extension shortcuts while leaving glob and regex patterns intact."""
    pattern = pattern.strip()
    if not pattern:
        return ""
    if pattern.startswith("re:"):
        return pattern
    if pattern.startswith(".") and not any(char in pattern for char in "*?[]/"):
        return f"*{pattern.lower()}"
    return pattern


def get_allowed_file_patterns() -> list[str]:
    """Return configured glob and regex file allowlist patterns."""
    patterns = [
        _normalize_allowed_file_pattern(pattern)
        for pattern in S3_ALLOWED_FILES_AND_EXTENSIONS.split(",")
    ]
    patterns = [pattern for pattern in patterns if pattern]
    if not patterns:
        raise ValueError(
            "S3_ALLOWED_FILES_AND_EXTENSIONS must include at least one glob or regex pattern"
        )

    for pattern in patterns:
        if not pattern.startswith("re:"):
            continue
        regex = pattern[3:]
        if not regex:
            raise ValueError("S3_ALLOWED_FILES_AND_EXTENSIONS includes an empty regex")
        try:
            re.compile(regex)
        except re.error as exc:
            raise ValueError(
                f"S3_ALLOWED_FILES_AND_EXTENSIONS includes an invalid regex: {exc}"
            ) from exc

    return patterns


def _matches_allowed_file_pattern(relative_key: str, pattern: str) -> bool:
    if pattern.startswith("re:"):
        return re.search(pattern[3:], relative_key) is not None

    path = PurePosixPath(relative_key)
    return (
        path.match(pattern)
        or fnmatchcase(relative_key, pattern)
        or fnmatchcase(path.name, pattern)
    )


def get_ignore_prefixes() -> list[str]:
    """Return configured relative key prefixes to ignore."""
    return [prefix.strip() for prefix in S3_IGNORE_PREFIXES.split(",") if prefix.strip()]


def compile_ignore_regex(pattern: str | None = None) -> re.Pattern[str] | None:
    """Compile the configured ignore regex, if any."""
    raw_pattern = pattern if pattern is not None else S3_IGNORE_REGEX
    raw_pattern = raw_pattern.strip()
    if not raw_pattern:
        return None
    try:
        return re.compile(raw_pattern)
    except re.error as exc:
        raise ValueError(f"S3_IGNORE_REGEX is invalid: {exc}") from exc


def get_max_files_per_bucket() -> int:
    """Return the strict maximum number of filtered files allowed per bucket."""
    try:
        limit = int(S3_MAX_FILES_PER_BUCKET)
    except ValueError as exc:
        raise ValueError("S3_MAX_FILES_PER_BUCKET must be an integer") from exc

    if limit <= 0:
        raise ValueError("S3_MAX_FILES_PER_BUCKET must be greater than zero")

    return limit


def validate_file_limit(bucket: str, count: int, limit: int | None = None) -> None:
    """Reject buckets whose filtered object count exceeds the configured limit."""
    effective_limit = limit if limit is not None else get_max_files_per_bucket()
    if count > effective_limit:
        raise ValueError(
            f"S3 bucket {bucket} has {count} eligible files, exceeding limit {effective_limit}")


def _relative_key(key: str, source_prefix: str) -> str | None:
    if source_prefix and not key.startswith(source_prefix):
        return None
    return key[len(source_prefix):] if source_prefix else key


def should_ingest_key(
    key: str,
    *,
    source_prefix: str,
    allowed_file_patterns: Iterable[str],
    ignore_prefixes: Iterable[str] | None = None,
    ignore_regex: re.Pattern[str] | None = None,
) -> bool:
    """Return whether an S3 object key should be fetched and ingested."""
    relative_key = _relative_key(key, source_prefix)
    if relative_key is None or not relative_key:
        return False

    # Treat prefix placeholder keys and "directory" markers as non-documents.
    if key.endswith("/"):
        return False

    if not any(
        _matches_allowed_file_pattern(relative_key, pattern)
        for pattern in allowed_file_patterns
    ):
        return False

    for ignore_prefix in ignore_prefixes or []:
        if relative_key.startswith(ignore_prefix):
            return False

    if ignore_regex and ignore_regex.search(key):
        return False

    return True


def _format_last_modified(value: Any | None) -> str | None:
  if value is None:
    return None
  if hasattr(value, "isoformat"):
    return value.isoformat()
  return str(value)


def _document_id_for_object(obj: S3ObjectInfo) -> str:
  source_identity = f"{obj.account_name or 'default'}:{obj.s3_uri}"
  return hashlib.sha256(source_identity.encode("utf-8")).hexdigest()


def _safe_datasource_component(value: str) -> str:
  safe = re.sub(r"[^a-zA-Z0-9]+", "-", value.strip("/"))
  return safe.strip("-").lower()


def generate_datasource_id(bucket_spec: BucketSpec) -> str:
  """Generate a deterministic datasource ID for a bucket/prefix pair."""
  bucket_part = _safe_datasource_component(bucket_spec.bucket)
  account_part = _safe_datasource_component(bucket_spec.account_name or "")
  prefix_part = _safe_datasource_component(bucket_spec.prefix)
  parts = ["s3"]
  if account_part:
    parts.append(account_part)
  parts.append(bucket_part)
  if prefix_part:
    parts.append(prefix_part)
  return "-".join(parts)


def create_session(profile_name: str | None = None) -> boto3.Session:
  """Create a boto3 session for default or account-specific credentials."""
  if profile_name:
    return boto3.Session(profile_name=profile_name, region_name=AWS_REGION)
  return boto3.Session(region_name=AWS_REGION)


def create_s3_client(profile_name: str | None = None) -> Any:
  """Create an S3 client using default credentials or an account profile."""
  return create_session(profile_name=profile_name).client("s3", region_name=AWS_REGION)


def build_datasource_info(client: Client, bucket_spec: BucketSpec) -> DataSourceInfo:
  """Create DataSourceInfo for a configured S3 bucket/prefix."""
  datasource_id = generate_datasource_id(bucket_spec)
  s3_path = f"s3://{bucket_spec.bucket}/{bucket_spec.prefix}" if bucket_spec.prefix else f"s3://{bucket_spec.bucket}"
  account_context = f" ({bucket_spec.account_name})" if bucket_spec.account_name else ""
  return DataSourceInfo(
    datasource_id=datasource_id,
    name=f"S3: {bucket_spec.bucket}/{bucket_spec.prefix}{account_context}" if bucket_spec.prefix else f"S3: {bucket_spec.bucket}{account_context}",
    ingestor_id=client.ingestor_id or "",
    description=f"S3 documents from {s3_path}",
    source_type="s3",
    last_updated=int(time.time()),
    default_chunk_size=1000,
    default_chunk_overlap=200,
    reload_interval=SYNC_INTERVAL,
    metadata={
      "account_name": bucket_spec.account_name,
      "bucket_arn": bucket_spec.bucket_arn,
      "bucket": bucket_spec.bucket,
      "prefix": bucket_spec.prefix,
      "allowed_file_patterns": get_allowed_file_patterns(),
      "ignore_prefixes": get_ignore_prefixes(),
      "ignore_regex": S3_IGNORE_REGEX,
      "max_files_per_bucket": get_max_files_per_bucket(),
    },
  )


class S3DocumentLoader(BaseLoader):
  """LangChain loader that yields one Document per accepted S3 object."""

  def __init__(
    self,
    *,
    s3_client: Any,
    bucket_spec: BucketSpec,
    datasource_id: str,
    ingestor_id: str,
    fresh_until: int,
    allowed_file_patterns: Iterable[str],
    ignore_prefixes: Iterable[str] | None = None,
    ignore_regex: re.Pattern[str] | None = None,
    max_files_per_bucket: int | None = None,
  ) -> None:
    self.s3_client = s3_client
    self.bucket_spec = bucket_spec
    self.datasource_id = datasource_id
    self.ingestor_id = ingestor_id
    self.fresh_until = fresh_until
    self.allowed_file_patterns = list(allowed_file_patterns)
    self.ignore_prefixes = list(ignore_prefixes or [])
    self.ignore_regex = ignore_regex
    self.max_files_per_bucket = max_files_per_bucket if max_files_per_bucket is not None else get_max_files_per_bucket()

  def _list_object_infos(self) -> list[S3ObjectInfo]:
    paginator = self.s3_client.get_paginator("list_objects_v2")
    page_iterator = paginator.paginate(Bucket=self.bucket_spec.bucket, Prefix=self.bucket_spec.prefix)
    object_infos: list[S3ObjectInfo] = []

    for page in page_iterator:
      for obj in page.get("Contents", []):
        key = obj.get("Key", "")
        if not should_ingest_key(
          key,
          source_prefix=self.bucket_spec.prefix,
          allowed_file_patterns=self.allowed_file_patterns,
          ignore_prefixes=self.ignore_prefixes,
          ignore_regex=self.ignore_regex,
        ):
          continue
        object_infos.append(
          S3ObjectInfo(
            bucket=self.bucket_spec.bucket,
            key=key,
            prefix=self.bucket_spec.prefix,
            account_name=self.bucket_spec.account_name,
            etag=obj.get("ETag"),
            last_modified=obj.get("LastModified"),
            size=obj.get("Size"),
          )
        )

    validate_file_limit(self.bucket_spec.bucket, len(object_infos), self.max_files_per_bucket)
    return object_infos

  def _read_object_text(self, obj: S3ObjectInfo) -> str:
    response = self.s3_client.get_object(Bucket=obj.bucket, Key=obj.key)
    body = response["Body"].read()
    return body.decode("utf-8")

  def _to_document(self, obj: S3ObjectInfo, text: str) -> Document:
    document_id = _document_id_for_object(obj)
    metadata = DocumentMetadata(
      document_id=document_id,
      datasource_id=self.datasource_id,
      ingestor_id=self.ingestor_id,
      title=obj.file_name,
      description=f"S3 object {obj.s3_uri}",
      is_structured_entity=False,
      document_type="s3_object",
      document_ingested_at=int(time.time()),
      fresh_until=self.fresh_until,
      metadata={
        "source": "s3",
        "account_name": obj.account_name,
        "bucket": obj.bucket,
        "key": obj.key,
        "prefix": obj.prefix,
        "relative_key": obj.relative_key,
        "file_name": obj.file_name,
        "extension": obj.extension,
        "s3_uri": obj.s3_uri,
        "etag": obj.etag,
        "last_modified": _format_last_modified(obj.last_modified),
        "size": obj.size,
      },
    )
    return Document(id=document_id, page_content=text, metadata=metadata.model_dump())

  def lazy_load(self) -> Iterator[Document]:
    """Yield accepted S3 objects as LangChain Documents."""
    for obj in self._list_object_infos():
      text = self._read_object_text(obj)
      if not text.strip():
        logger.info(f"Skipping empty S3 object: {obj.s3_uri}")
        continue
      yield self._to_document(obj, text)


async def sync_s3_buckets(client: Client) -> None:
  """Sync configured S3 buckets into RAG."""
  bucket_specs = get_bucket_specs()
  accounts = parse_account_list()
  validate_bucket_account_specs(bucket_specs, accounts)
  setup_aws_profiles(accounts)
  allowed_file_patterns = get_allowed_file_patterns()
  ignore_prefixes = get_ignore_prefixes()
  ignore_regex = compile_ignore_regex()
  max_files_per_bucket = get_max_files_per_bucket()
  s3_clients: dict[str | None, Any] = {}

  for bucket_spec in bucket_specs:
    if bucket_spec.account_name not in s3_clients:
      s3_clients[bucket_spec.account_name] = create_s3_client(bucket_spec.account_name)
    s3_client = s3_clients[bucket_spec.account_name]
    datasource_info = build_datasource_info(client, bucket_spec)
    async def sync_datasource() -> None:
      await client.upsert_datasource(datasource_info)

      fresh_until = utils.get_fresh_until(SYNC_INTERVAL)
      loader = S3DocumentLoader(
        s3_client=s3_client,
        bucket_spec=bucket_spec,
        datasource_id=datasource_info.datasource_id,
        ingestor_id=client.ingestor_id or "",
        fresh_until=fresh_until,
        allowed_file_patterns=allowed_file_patterns,
        ignore_prefixes=ignore_prefixes,
        ignore_regex=ignore_regex,
        max_files_per_bucket=max_files_per_bucket,
      )

      job_response = await client.create_job(
        datasource_id=datasource_info.datasource_id,
        job_status=JobStatus.IN_PROGRESS,
        message=f"Syncing S3 documents from {bucket_spec.bucket}:{bucket_spec.prefix}",
        total=0,
      )
      job_id = job_response["job_id"]

      try:
        documents = (await asyncio.to_thread(list, loader.lazy_load()))
        await client.update_job(
          job_id=job_id,
          job_status=JobStatus.IN_PROGRESS,
          message=f"Loaded {len(documents)} S3 documents from {bucket_spec.bucket}:{bucket_spec.prefix}",
          total=len(documents),
        )
        if documents:
          await client.ingest_documents(
            job_id=job_id,
            datasource_id=datasource_info.datasource_id,
            documents=documents,
            fresh_until=fresh_until,
          )
        await client.update_job(
          job_id=job_id,
          job_status=JobStatus.COMPLETED,
          message=f"Successfully ingested {len(documents)} S3 documents from {bucket_spec.bucket}:{bucket_spec.prefix}",
        )
      except Exception as exc:
        error_msg = f"S3 sync failed for {bucket_spec.bucket}:{bucket_spec.prefix}: {exc}"
        await client.add_job_error(job_id, [error_msg])
        await client.update_job(
          job_id=job_id,
          job_status=JobStatus.FAILED,
          message=error_msg,
        )
        logger.error(error_msg, exc_info=True)
        raise

    await run_standalone_ingestion(datasource_info.datasource_id, sync_datasource)


if __name__ == "__main__":
    try:
        bucket_specs = get_bucket_specs()
        accounts = parse_account_list()
        setup_aws_profiles(accounts)
        logger.info(
            f"Starting S3 ingestor for {len(bucket_specs)} configured bucket specs in {AWS_REGION}")

        IngestorBuilder().name("s3-ingestor").type("s3").description("S3 object contents ingestor for RAG").metadata(
            {
                "bucket_specs": [spec.__dict__ for spec in bucket_specs],
                "accounts": accounts,
                "allowed_file_patterns": get_allowed_file_patterns(),
                "max_files_per_bucket": get_max_files_per_bucket(),
                "sync_interval": SYNC_INTERVAL,
            }
        ).sync_with_fn(sync_s3_buckets).every(SYNC_INTERVAL).with_init_delay(int(os.getenv("INIT_DELAY_SECONDS", "0"))).run()
    except KeyboardInterrupt:
        logger.info("S3 ingestor execution interrupted by user")
    except Exception as exc:
        logger.error(f"S3 ingestor failed: {exc}", exc_info=True)
        raise