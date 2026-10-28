"""Unit tests for the S3 ingestor.

Initial coverage focuses on the source-selection safety rules:
  - S3_BUCKETS env parsing as CSV S3 bucket ARNs
  - S3_ALLOWED_FILES_AND_EXTENSIONS glob and regex allowlist defaults
  - configured extension shortcut normalization
  - ignore prefix filtering
  - ignore regex filtering
  - strict max files per bucket validation

These tests are intentionally written before the ingestor implementation so the
first implementation pass has a small, reviewable contract to satisfy.
"""

from __future__ import annotations

from datetime import datetime, timezone
from io import BytesIO
import importlib
import os
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest


BASE_ENV = {
  "S3_BUCKETS": "arn:aws:s3:::docs-bucket,arn:aws:s3:::shared-docs",
  "AWS_REGION": "us-east-2",
}


def _load_ingestor(env: dict[str, str] | None = None):
  """Import or reload the S3 ingestor with a controlled environment."""
  merged_env = {**BASE_ENV, **(env or {})}
  with patch.dict(os.environ, merged_env, clear=True):
    import ingestors.s3.ingestor as mod

    return importlib.reload(mod)


class TestBucketConfigParsing:
  def test_parse_bucket_specs_supports_bucket_arn_csv(self):
    mod = _load_ingestor()

    configs = mod.parse_bucket_specs("arn:aws:s3:::docs-bucket,arn:aws:s3:::shared-docs")

    assert [(c.bucket, c.prefix) for c in configs] == [
      ("docs-bucket", ""),
      ("shared-docs", ""),
    ]
    assert [c.account_name for c in configs] == [None, None]
    assert [c.bucket_arn for c in configs] == [
      "arn:aws:s3:::docs-bucket",
      "arn:aws:s3:::shared-docs",
    ]

  def test_parse_bucket_specs_supports_account_qualified_bucket_arns(self):
    mod = _load_ingestor()

    configs = mod.parse_bucket_specs(
      "dev:arn:aws:s3:::docs-bucket,prod:arn:aws:s3:::shared-docs"
    )

    assert [(c.account_name, c.bucket, c.prefix, c.bucket_arn) for c in configs] == [
      ("dev", "docs-bucket", "", "arn:aws:s3:::docs-bucket"),
      ("prod", "shared-docs", "", "arn:aws:s3:::shared-docs"),
    ]

  def test_parse_bucket_specs_trims_whitespace(self):
    mod = _load_ingestor()

    configs = mod.parse_bucket_specs(" arn:aws:s3:::docs-bucket , arn:aws:s3:::shared-docs ")

    assert [(c.bucket, c.prefix) for c in configs] == [
      ("docs-bucket", ""),
      ("shared-docs", ""),
    ]

  def test_parse_bucket_specs_rejects_missing_bucket_name(self):
    mod = _load_ingestor()

    with pytest.raises(ValueError, match="bucket"):
      mod.parse_bucket_specs(" , ")

  def test_parse_bucket_specs_rejects_bucket_names(self):
    mod = _load_ingestor()

    with pytest.raises(ValueError, match="bucket ARNs"):
      mod.parse_bucket_specs("docs-bucket")

  def test_parse_bucket_specs_rejects_old_account_qualified_bucket_names(self):
    mod = _load_ingestor()

    with pytest.raises(ValueError, match="bucket ARNs"):
      mod.parse_bucket_specs("dev:docs-bucket")

  def test_parse_bucket_specs_rejects_object_arns_for_mvp(self):
    mod = _load_ingestor()

    with pytest.raises(ValueError, match="object or prefix ARNs"):
      mod.parse_bucket_specs("arn:aws:s3:::docs-bucket/runbooks/service.md")

  def test_parse_bucket_specs_rejects_non_s3_arns(self):
    mod = _load_ingestor()

    with pytest.raises(ValueError, match="S3 bucket ARNs"):
      mod.parse_bucket_specs("arn:aws:iam::111111111111:role/caipe-read-only")


class TestAccountConfig:
  def test_parse_account_list_supports_name_and_account_id_pairs(self):
    mod = _load_ingestor({"AWS_ACCOUNT_LIST": "dev:111111111111,prod:222222222222"})

    assert mod.parse_account_list() == [
      {"name": "dev", "id": "111111111111"},
      {"name": "prod", "id": "222222222222"},
    ]

  def test_validate_bucket_account_specs_requires_qualified_buckets_in_multi_account_mode(self):
    mod = _load_ingestor({"AWS_ACCOUNT_LIST": "dev:111111111111"})
    bucket_specs = [mod.BucketSpec(bucket="docs-bucket", prefix="")]
    accounts = mod.parse_account_list()

    with pytest.raises(ValueError, match="account names"):
      mod.validate_bucket_account_specs(bucket_specs, accounts)

  def test_validate_bucket_account_specs_rejects_unknown_bucket_account(self):
    mod = _load_ingestor({"AWS_ACCOUNT_LIST": "dev:111111111111"})
    bucket_specs = [mod.BucketSpec(bucket="docs-bucket", prefix="", account_name="prod")]
    accounts = mod.parse_account_list()

    with pytest.raises(ValueError, match="AWS_ACCOUNT_LIST"):
      mod.validate_bucket_account_specs(bucket_specs, accounts)

  def test_setup_aws_profiles_generates_assume_role_profiles(self, tmp_path):
    mod = _load_ingestor({
      "AWS_ACCOUNT_LIST": "dev:111111111111",
      "CROSS_ACCOUNT_ROLE_NAME": "caipe-read-only",
    })
    home = tmp_path / "home"
    home.mkdir()

    with patch.dict(os.environ, {"HOME": str(home)}, clear=False):
      mod.setup_aws_profiles(mod.parse_account_list())
      config_path = Path(os.environ["AWS_CONFIG_FILE"])
      assert config_path.exists()
      assert config_path.read_text() == (
        "# AUTO-GENERATED PROFILES FROM S3 AWS_ACCOUNT_LIST\n"
        "# Regenerated at ingestor startup - do not edit manually\n\n"
        "[profile dev]\n"
        "role_arn = arn:aws:iam::111111111111:role/caipe-read-only\n"
        "credential_source = Environment\n"
      )

  def test_create_s3_client_uses_named_profile_session_for_account(self):
    mod = _load_ingestor({"AWS_REGION": "us-west-2"})
    session = MagicMock()

    with patch.object(mod.boto3, "Session", return_value=session) as session_factory:
      client = mod.create_s3_client("dev")

    session_factory.assert_called_once_with(profile_name="dev", region_name="us-west-2")
    session.client.assert_called_once_with("s3", region_name="us-west-2")
    assert client == session.client.return_value


class TestFilePatternConfig:
  def test_module_default_allowed_file_patterns_env_string_matches_defaults(self):
    mod = _load_ingestor()

    assert mod.S3_ALLOWED_FILES_AND_EXTENSIONS == ",".join(
      sorted(mod.DEFAULT_ALLOWED_FILE_PATTERNS)
    )

  def test_module_allowed_file_patterns_uses_env_override(self):
    mod = _load_ingestor({"S3_ALLOWED_FILES_AND_EXTENSIONS": "*.md,re:^runbooks/.*\\.txt$"})

    assert mod.S3_ALLOWED_FILES_AND_EXTENSIONS == "*.md,re:^runbooks/.*\\.txt$"

  def test_default_allowed_file_patterns_cover_documentation_extensions(self):
    mod = _load_ingestor()

    assert mod.get_allowed_file_patterns() == ["*.adoc", "*.asciidoc", "*.md", "*.rst", "*.txt"]

  def test_allowed_file_patterns_normalize_extension_shortcuts(self):
    mod = _load_ingestor({"S3_ALLOWED_FILES_AND_EXTENSIONS": ".txt, .MD"})

    assert mod.get_allowed_file_patterns() == ["*.txt", "*.md"]

  def test_allowed_file_patterns_accept_globs_and_regexes(self):
    mod = _load_ingestor({
      "S3_ALLOWED_FILES_AND_EXTENSIONS": "README.md,runbooks/**/*.md,re:^adr/[0-9]+-.+\\.rst$"
    })

    assert mod.get_allowed_file_patterns() == [
      "README.md",
      "runbooks/**/*.md",
      "re:^adr/[0-9]+-.+\\.rst$",
    ]

  def test_empty_allowed_file_patterns_rejected(self):
    mod = _load_ingestor({"S3_ALLOWED_FILES_AND_EXTENSIONS": " , "})

    with pytest.raises(ValueError, match="S3_ALLOWED_FILES_AND_EXTENSIONS"):
      mod.get_allowed_file_patterns()

  def test_invalid_allowed_file_regex_rejected(self):
    mod = _load_ingestor({"S3_ALLOWED_FILES_AND_EXTENSIONS": "re:["})

    with pytest.raises(ValueError, match="invalid regex"):
      mod.get_allowed_file_patterns()


class TestObjectFiltering:
  def test_should_ingest_key_accepts_documentation_extensions_under_source_prefix(self):
    mod = _load_ingestor()
    allowed = ["*.txt", "*.md", "*.rst", "*.adoc", "*.asciidoc"]

    assert mod.should_ingest_key("runbooks/service-a.md", source_prefix="runbooks/", allowed_file_patterns=allowed)
    assert mod.should_ingest_key("runbooks/service-b.txt", source_prefix="runbooks/", allowed_file_patterns=allowed)
    assert mod.should_ingest_key("runbooks/service-c.rst", source_prefix="runbooks/", allowed_file_patterns=allowed)
    assert mod.should_ingest_key("runbooks/service-d.adoc", source_prefix="runbooks/", allowed_file_patterns=allowed)
    assert mod.should_ingest_key("runbooks/service-e.asciidoc", source_prefix="runbooks/", allowed_file_patterns=allowed)

  def test_should_ingest_key_rejects_unsupported_extensions(self):
    mod = _load_ingestor()
    allowed = ["*.txt", "*.md"]

    assert not mod.should_ingest_key("runbooks/service-a.pdf", source_prefix="runbooks/", allowed_file_patterns=allowed)
    assert not mod.should_ingest_key("runbooks/service-a.json", source_prefix="runbooks/", allowed_file_patterns=allowed)

  def test_should_ingest_key_rejects_yaml_and_logs_for_sensitivity(self):
    """YAML and log files are intentionally out of scope for v1.

    They are plain text, but are more likely to contain secrets, config dumps,
    tokens, credentials, request logs, or other noisy operational data.
    """
    mod = _load_ingestor()
    allowed = ["*.txt", "*.md", "*.rst", "*.adoc", "*.asciidoc"]

    assert not mod.should_ingest_key("runbooks/values.yaml", source_prefix="runbooks/", allowed_file_patterns=allowed)
    assert not mod.should_ingest_key("runbooks/config.yml", source_prefix="runbooks/", allowed_file_patterns=allowed)
    assert not mod.should_ingest_key("runbooks/debug.log", source_prefix="runbooks/", allowed_file_patterns=allowed)

  def test_should_ingest_key_accepts_configured_path_globs(self):
    mod = _load_ingestor()
    allowed = ["runbooks/**/*.md"]

    assert mod.should_ingest_key(
      "runbooks/services/service-a.md",
      source_prefix="",
      allowed_file_patterns=allowed,
    )
    assert not mod.should_ingest_key(
      "notes/service-a.md",
      source_prefix="",
      allowed_file_patterns=allowed,
    )

  def test_should_ingest_key_accepts_configured_regexes(self):
    mod = _load_ingestor()
    allowed = [r"re:^adr/[0-9]+-.+\.rst$"]

    assert mod.should_ingest_key(
      "adr/001-s3-ingestor.rst",
      source_prefix="",
      allowed_file_patterns=allowed,
    )
    assert not mod.should_ingest_key(
      "adr/s3-ingestor.rst",
      source_prefix="",
      allowed_file_patterns=allowed,
    )

  def test_should_ingest_key_rejects_keys_outside_source_prefix(self):
    mod = _load_ingestor()

    assert not mod.should_ingest_key(
      "other/service-a.md",
      source_prefix="runbooks/",
      allowed_file_patterns=["*.md"],
    )

  def test_should_ingest_key_applies_ignore_prefixes_after_source_prefix(self):
    mod = _load_ingestor()

    assert not mod.should_ingest_key(
      "runbooks/archive/old-service.md",
      source_prefix="runbooks/",
      allowed_file_patterns=["*.md"],
      ignore_prefixes=["archive/"],
    )
    assert mod.should_ingest_key(
      "runbooks/current/service.md",
      source_prefix="runbooks/",
      allowed_file_patterns=["*.md"],
      ignore_prefixes=["archive/"],
    )

  def test_should_ingest_key_applies_ignore_regex_to_full_key(self):
    mod = _load_ingestor()
    ignore_regex = mod.compile_ignore_regex(r"(^|/)drafts/|\.bak$")

    assert not mod.should_ingest_key(
      "runbooks/drafts/service.md",
      source_prefix="runbooks/",
      allowed_file_patterns=["*.md"],
      ignore_regex=ignore_regex,
    )
    assert not mod.should_ingest_key(
      "runbooks/service.md.bak",
      source_prefix="runbooks/",
      allowed_file_patterns=["*.md"],
      ignore_regex=ignore_regex,
    )
    assert mod.should_ingest_key(
      "runbooks/service.md",
      source_prefix="runbooks/",
      allowed_file_patterns=["*.md"],
      ignore_regex=ignore_regex,
    )


class TestMaxFilesLimit:
  def test_default_max_files_per_bucket_is_2000(self):
    mod = _load_ingestor()

    assert mod.get_max_files_per_bucket() == 2000

  def test_validate_file_limit_allows_count_at_limit(self):
    mod = _load_ingestor({"S3_MAX_FILES_PER_BUCKET": "2"})

    mod.validate_file_limit(bucket="docs-bucket", count=2)

  def test_validate_file_limit_rejects_count_above_limit(self):
    mod = _load_ingestor({"S3_MAX_FILES_PER_BUCKET": "2"})

    with pytest.raises(ValueError, match="docs-bucket"):
      mod.validate_file_limit(bucket="docs-bucket", count=3)

  def test_invalid_max_files_env_rejected(self):
    mod = _load_ingestor({"S3_MAX_FILES_PER_BUCKET": "not-a-number"})

    with pytest.raises(ValueError, match="S3_MAX_FILES_PER_BUCKET"):
      mod.get_max_files_per_bucket()


class TestS3DocumentLoader:
  def _make_s3_client(self, objects: list[dict], bodies: dict[str, bytes]):
    paginator = MagicMock()
    paginator.paginate.return_value = [{"Contents": objects}]

    s3_client = MagicMock()
    s3_client.get_paginator.return_value = paginator
    s3_client.get_object.side_effect = lambda Bucket, Key: {"Body": BytesIO(bodies[Key])}
    return s3_client

  def test_lazy_load_yields_documents_for_root_and_nested_files(self):
    mod = _load_ingestor()
    last_modified = datetime(2026, 6, 5, 12, 0, tzinfo=timezone.utc)
    objects = [
      {"Key": "README.md", "ETag": '"root-etag"', "LastModified": last_modified, "Size": 14},
      {"Key": "runbooks/service-a.rst", "ETag": '"nested-etag"', "LastModified": last_modified, "Size": 18},
    ]
    bodies = {
      "README.md": b"# Root readme\n",
      "runbooks/service-a.rst": b"Service A Runbook\n",
    }
    s3_client = self._make_s3_client(objects, bodies)

    loader = mod.S3DocumentLoader(
      s3_client=s3_client,
      bucket_spec=mod.BucketSpec(bucket="docs-bucket", prefix=""),
      datasource_id="s3-docs-bucket",
      ingestor_id="s3:test",
      fresh_until=1234567890,
      allowed_file_patterns=["*.md", "*.rst"],
    )

    documents = list(loader.lazy_load())

    assert [doc.page_content for doc in documents] == ["# Root readme\n", "Service A Runbook\n"]
    assert documents[0].metadata["document_type"] == "s3_object"
    assert documents[0].metadata["title"] == "README.md"
    assert documents[0].metadata["fresh_until"] == 1234567890
    assert documents[0].metadata["metadata"] == {
      "source": "s3",
      "account_name": None,
      "bucket": "docs-bucket",
      "key": "README.md",
      "prefix": "",
      "relative_key": "README.md",
      "file_name": "README.md",
      "extension": ".md",
      "s3_uri": "s3://docs-bucket/README.md",
      "etag": '"root-etag"',
      "last_modified": "2026-06-05T12:00:00+00:00",
      "size": 14,
    }
    assert documents[1].metadata["metadata"]["relative_key"] == "runbooks/service-a.rst"
    assert documents[1].metadata["metadata"]["file_name"] == "service-a.rst"

  def test_lazy_load_applies_prefix_and_ignore_filters_before_download(self):
    mod = _load_ingestor()
    objects = [
      {"Key": "runbooks/service-a.md", "Size": 10},
      {"Key": "runbooks/archive/old.md", "Size": 10},
      {"Key": "runbooks/drafts/wip.md", "Size": 10},
      {"Key": "runbooks/values.yaml", "Size": 10},
      {"Key": "other/service-b.md", "Size": 10},
    ]
    bodies = {"runbooks/service-a.md": b"# Service A\n"}
    s3_client = self._make_s3_client(objects, bodies)

    loader = mod.S3DocumentLoader(
      s3_client=s3_client,
      bucket_spec=mod.BucketSpec(bucket="docs-bucket", prefix="runbooks/"),
      datasource_id="s3-docs-bucket-runbooks",
      ingestor_id="s3:test",
      fresh_until=1234567890,
      allowed_file_patterns=["*.md"],
      ignore_prefixes=["archive/"],
      ignore_regex=mod.compile_ignore_regex(r"(^|/)drafts/"),
    )

    documents = list(loader.lazy_load())

    assert len(documents) == 1
    assert documents[0].metadata["metadata"]["key"] == "runbooks/service-a.md"
    s3_client.get_object.assert_called_once_with(Bucket="docs-bucket", Key="runbooks/service-a.md")

  def test_lazy_load_enforces_max_files_before_download(self):
    mod = _load_ingestor()
    objects = [
      {"Key": "runbooks/a.md", "Size": 10},
      {"Key": "runbooks/b.md", "Size": 10},
      {"Key": "runbooks/c.md", "Size": 10},
    ]
    s3_client = self._make_s3_client(objects, {})

    loader = mod.S3DocumentLoader(
      s3_client=s3_client,
      bucket_spec=mod.BucketSpec(bucket="docs-bucket", prefix="runbooks/"),
      datasource_id="s3-docs-bucket-runbooks",
      ingestor_id="s3:test",
      fresh_until=1234567890,
      allowed_file_patterns=["*.md"],
      max_files_per_bucket=2,
    )

    with pytest.raises(ValueError, match="docs-bucket"):
      list(loader.lazy_load())
    s3_client.get_object.assert_not_called()

  def test_lazy_load_rejects_non_utf8_content(self):
    mod = _load_ingestor()
    objects = [{"Key": "runbooks/binary.md", "Size": 3}]
    s3_client = self._make_s3_client(objects, {"runbooks/binary.md": b"\xff\xfe\x00"})

    loader = mod.S3DocumentLoader(
      s3_client=s3_client,
      bucket_spec=mod.BucketSpec(bucket="docs-bucket", prefix="runbooks/"),
      datasource_id="s3-docs-bucket-runbooks",
      ingestor_id="s3:test",
      fresh_until=1234567890,
      allowed_file_patterns=["*.md"],
    )

    with pytest.raises(UnicodeDecodeError):
      list(loader.lazy_load())


class TestSyncS3Buckets:
  @pytest.fixture(autouse=True)
  def _mock_storage(self, monkeypatch):
    storage = AsyncMock()
    monkeypatch.setattr("common.ingestor_listener.MongoStorage", MagicMock(return_value=storage))

  def _make_s3_client(self, objects: list[dict], bodies: dict[str, bytes]):
    paginator = MagicMock()
    paginator.paginate.return_value = [{"Contents": objects}]

    s3_client = MagicMock()
    s3_client.get_paginator.return_value = paginator
    s3_client.get_object.side_effect = lambda Bucket, Key: {"Body": BytesIO(bodies[Key])}
    return s3_client

  def _make_client(self):
    client = MagicMock()
    client.ingestor_id = "s3:test-ingestor"
    client.upsert_datasource = AsyncMock()
    client.create_job = AsyncMock(return_value={"job_id": "job-1"})
    client.ingest_documents = AsyncMock()
    client.update_job = AsyncMock()
    client.add_job_error = AsyncMock()
    return client

  @pytest.mark.asyncio
  async def test_sync_s3_buckets_creates_datasource_job_and_ingests_documents(self):
    mod = _load_ingestor({"S3_BUCKETS": "arn:aws:s3:::docs-bucket"})
    last_modified = datetime(2026, 6, 5, 12, 0, tzinfo=timezone.utc)
    s3_client = self._make_s3_client(
      objects=[{"Key": "runbooks/service-a.md", "ETag": '"etag-a"', "LastModified": last_modified, "Size": 12}],
      bodies={"runbooks/service-a.md": b"# Service A\n"},
    )
    client = self._make_client()

    with patch.object(mod, "create_s3_client", return_value=s3_client):
      await mod.sync_s3_buckets(client)

    client.upsert_datasource.assert_called_once()
    datasource = client.upsert_datasource.call_args.args[0]
    assert datasource.datasource_id == "s3-docs-bucket"
    assert datasource.source_type == "s3"
    assert datasource.default_chunk_size == 1000
    assert datasource.default_chunk_overlap == 200
    assert datasource.metadata["bucket_arn"] == "arn:aws:s3:::docs-bucket"

    client.create_job.assert_called_once()
    assert client.create_job.call_args.kwargs["datasource_id"] == "s3-docs-bucket"
    assert client.create_job.call_args.kwargs["total"] == 0
    assert any(call.kwargs.get("total") == 1 for call in client.update_job.call_args_list)

    client.ingest_documents.assert_called_once()
    ingest_kwargs = client.ingest_documents.call_args.kwargs
    assert ingest_kwargs["job_id"] == "job-1"
    assert ingest_kwargs["datasource_id"] == "s3-docs-bucket"
    assert len(ingest_kwargs["documents"]) == 1
    assert ingest_kwargs["documents"][0].page_content == "# Service A\n"
    assert isinstance(ingest_kwargs["fresh_until"], int)

    assert client.update_job.call_args_list[-1].kwargs["job_status"].value == "completed"

  @pytest.mark.asyncio
  async def test_sync_s3_buckets_uses_account_specific_s3_clients(self):
    mod = _load_ingestor({
      "S3_BUCKETS": "dev:arn:aws:s3:::docs-bucket,prod:arn:aws:s3:::shared-docs",
      "AWS_ACCOUNT_LIST": "dev:111111111111,prod:222222222222",
    })
    dev_s3_client = self._make_s3_client(
      objects=[{"Key": "README.md", "Size": 10}],
      bodies={"README.md": b"# Dev docs\n"},
    )
    prod_s3_client = self._make_s3_client(
      objects=[{"Key": "README.md", "Size": 11}],
      bodies={"README.md": b"# Prod docs\n"},
    )
    client = self._make_client()

    with patch.object(mod, "setup_aws_profiles") as setup_profiles:
      with patch.object(mod, "create_s3_client", side_effect=[dev_s3_client, prod_s3_client]) as create_s3_client:
        await mod.sync_s3_buckets(client)

    setup_profiles.assert_called_once_with([
      {"name": "dev", "id": "111111111111"},
      {"name": "prod", "id": "222222222222"},
    ])
    assert [call.args[0] for call in create_s3_client.call_args_list] == ["dev", "prod"]
    assert [call.args[0].datasource_id for call in client.upsert_datasource.call_args_list] == [
      "s3-dev-docs-bucket",
      "s3-prod-shared-docs",
    ]
    assert client.ingest_documents.call_count == 2
    first_document = client.ingest_documents.call_args_list[0].kwargs["documents"][0]
    assert first_document.metadata["metadata"]["account_name"] == "dev"

  @pytest.mark.asyncio
  async def test_sync_s3_buckets_completes_when_no_documents_match(self):
    mod = _load_ingestor({"S3_BUCKETS": "arn:aws:s3:::docs-bucket"})
    s3_client = self._make_s3_client(
      objects=[{"Key": "runbooks/values.yaml", "Size": 12}],
      bodies={},
    )
    client = self._make_client()

    with patch.object(mod, "create_s3_client", return_value=s3_client):
      await mod.sync_s3_buckets(client)

    client.ingest_documents.assert_not_called()
    assert client.create_job.call_args.kwargs["total"] == 0
    assert client.update_job.call_args.kwargs["job_status"].value == "completed"

  @pytest.mark.asyncio
  async def test_sync_s3_buckets_marks_job_failed_on_loader_error(self):
    mod = _load_ingestor({
      "S3_BUCKETS": "arn:aws:s3:::docs-bucket",
      "S3_MAX_FILES_PER_BUCKET": "1",
    })
    s3_client = self._make_s3_client(
      objects=[
        {"Key": "runbooks/a.md", "Size": 10},
        {"Key": "runbooks/b.md", "Size": 10},
      ],
      bodies={},
    )
    client = self._make_client()

    with patch.object(mod, "create_s3_client", return_value=s3_client):
      with pytest.raises(ValueError, match="docs-bucket"):
        await mod.sync_s3_buckets(client)

    client.add_job_error.assert_called_once()
    assert "docs-bucket" in client.add_job_error.call_args.args[1][0]
    assert client.update_job.call_args.kwargs["job_status"].value == "failed"
