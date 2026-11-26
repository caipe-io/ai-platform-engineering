import os
import asyncio
import re
import time
import logging
import requests
from typing import List, Dict, Any, Optional
from urllib.parse import urljoin

from common.ingestor_listener import run_standalone_ingestion
from common.ingestor import IngestorBuilder, Client
from common.models.rag import StructuredEntity
from common.models.rag import DataSourceInfo
from common.job_manager import JobStatus
import common.utils as utils

"""
ArgoCD v3 Ingestor - Ingests entities from ArgoCD into the RAG system.
Uses the IngestorBuilder pattern for simplified ingestor creation with automatic job management and batching.
Conforms to ArgoCD API v1 specification.
"""

LOG_LEVEL = os.environ.get("LOG_LEVEL", "INFO").upper()
logging.basicConfig(level=LOG_LEVEL)

# ArgoCD configuration
SERVER_URL = str(os.getenv("SERVER_URL"))
if SERVER_URL is None:
  raise ValueError("SERVER_URL environment variable must be set")
ARGOCD_AUTH_TOKEN = str(os.getenv("ARGOCD_AUTH_TOKEN"))
if ARGOCD_AUTH_TOKEN is None:
  raise ValueError("ARGOCD_AUTH_TOKEN environment variable must be set")
ARGOCD_VERIFY_SSL = os.getenv("ARGOCD_VERIFY_SSL", "true").lower() == "true"
ARGOCD_FILTER_PROJECTS = os.getenv("ARGOCD_FILTER_PROJECTS", "").strip()
SYNC_INTERVAL = int(os.getenv("SYNC_INTERVAL", 86400))  # sync every day by default


# Create instance name from server URL - sanitize by replacing all non-alphanumeric chars with underscore
def sanitize_instance_name(url: str) -> str:
  """Replace all non-alphanumeric characters in URL with underscores"""
  return re.sub(r"[^a-zA-Z0-9]", "_", url)


argocd_instance_name = "argocdv3_" + sanitize_instance_name(SERVER_URL)

# Filter projects if specified
FILTER_PROJECTS = [p.strip() for p in ARGOCD_FILTER_PROJECTS.split(",") if p.strip()] if ARGOCD_FILTER_PROJECTS else []

# Field filtering - fields to ignore from resource manifests
default_ignore_field_list = "metadata.annotations.kubectl.kubernetes.io,metadata.labels.app.kubernetes.io,metadata.managedFields,metadata.selfLink,status"
ignore_field_list_str = os.environ.get("IGNORE_FIELD_LIST", default_ignore_field_list)
IGNORE_FIELD_LIST: List[str] = [f.strip() for f in ignore_field_list_str.split(",")]


class ArgoCDClient:
  """Client for interacting with ArgoCD API v1"""

  def __init__(self, base_url: str, auth_token: str, verify_ssl: bool = True):
    self.base_url = base_url.rstrip("/")
    self.auth_token = auth_token
    self.verify_ssl = verify_ssl
    self.session = requests.Session()
    self.session.headers.update({"Authorization": f"Bearer {auth_token}", "Content-Type": "application/json"})

  def _make_request(self, endpoint: str, method: str = "GET", params: Optional[Dict[str, Any]] = None, **kwargs) -> Any:
    """Make a request to the ArgoCD API"""
    url = urljoin(self.base_url, endpoint)
    try:
      response = self.session.request(method=method, url=url, params=params, verify=self.verify_ssl, **kwargs)
      response.raise_for_status()
      json_response = response.json()
      # Handle None response from API
      if json_response is None:
        return {}
      return json_response
    except requests.exceptions.RequestException as e:
      logging.error(f"Error making request to {url}: {e}")
      raise

  def get_applications(self, projects: Optional[List[str]] = None) -> List[Dict[str, Any]]:
    """
    Fetch all applications, optionally filtered by projects.
    Uses GET /api/v1/applications endpoint with 'projects' query parameter.
    Returns items from v1alpha1ApplicationList.
    """
    logging.info("Fetching applications from ArgoCD...")
    params = {}
    if projects:
      # ArgoCD API accepts multiple projects as repeated query parameters
      params["projects"] = projects

    try:
      response = self._make_request("/api/v1/applications", params=params)
      # Response is v1alpha1ApplicationList with 'items' array
      apps = response.get("items", []) if isinstance(response, dict) else []
      logging.info(f"Fetched {len(apps)} applications")
      return apps
    except Exception as e:
      logging.error(f"Error fetching applications: {e}")
      return []

  def get_projects(self) -> List[Dict[str, Any]]:
    """
    Fetch all projects.
    Uses GET /api/v1/projects endpoint.
    Returns items from v1alpha1AppProjectList.
    """
    logging.info("Fetching projects from ArgoCD...")
    try:
      response = self._make_request("/api/v1/projects")
      # Response is v1alpha1AppProjectList with 'items' array
      projects = response.get("items", []) if isinstance(response, dict) else []
      logging.info(f"Fetched {len(projects)} projects")
      return projects
    except Exception as e:
      logging.error(f"Error fetching projects: {e}")
      return []

  def get_clusters(self) -> List[Dict[str, Any]]:
    """
    Fetch all clusters.
    Uses GET /api/v1/clusters endpoint.
    Returns items from v1alpha1ClusterList.
    """
    logging.info("Fetching clusters from ArgoCD...")
    try:
      response = self._make_request("/api/v1/clusters")
      # Response is v1alpha1ClusterList with 'items' array
      clusters = response.get("items", []) if isinstance(response, dict) else []
      logging.info(f"Fetched {len(clusters)} clusters")
      return clusters
    except Exception as e:
      logging.error(f"Error fetching clusters: {e}")
      return []

  def get_repositories(self) -> List[Dict[str, Any]]:
    """
    Fetch all repositories.
    Uses GET /api/v1/repositories endpoint.
    Returns items from v1alpha1RepositoryList.
    """
    logging.info("Fetching repositories from ArgoCD...")
    try:
      response = self._make_request("/api/v1/repositories")
      # Response is v1alpha1RepositoryList with 'items' array
      repos = response.get("items", []) if isinstance(response, dict) else []
      logging.info(f"Fetched {len(repos)} repositories")
      return repos
    except Exception as e:
      logging.error(f"Error fetching repositories: {e}")
      return []

  def get_applicationsets(self, projects: Optional[List[str]] = None) -> List[Dict[str, Any]]:
    """
    Fetch all applicationsets.
    Uses GET /api/v1/applicationsets endpoint with optional 'projects' query parameter.
    Returns items from v1alpha1ApplicationSetList.
    """
    logging.info("Fetching applicationsets from ArgoCD...")
    params = {}
    if projects:
      # ArgoCD API accepts multiple projects as repeated query parameters
      params["projects"] = projects

    try:
      response = self._make_request("/api/v1/applicationsets", params=params)
      # Response is v1alpha1ApplicationSetList with 'items' array
      appsets = response.get("items", []) if isinstance(response, dict) else []
      logging.info(f"Fetched {len(appsets)} applicationsets")
      return appsets
    except Exception as e:
      logging.error(f"Error fetching applicationsets: {e}")
      return []


def should_ignore_field(field_path: str) -> bool:
  """
  Check if a field should be ignored based on IGNORE_FIELD_LIST.

  Args:
      field_path: Dot-separated field path (e.g., "metadata.managedFields")

  Returns:
      True if field should be ignored, False otherwise
  """
  for ignore_pattern in IGNORE_FIELD_LIST:
    if field_path.startswith(ignore_pattern):
      return True
  return False


def extract_project_roles(project: Dict[str, Any]) -> List[Dict[str, Any]]:
  """Extract RBAC roles from a project"""
  roles = []
  project_name = project.get("metadata", {}).get("name", "unknown")

  for role in project.get("spec", {}).get("roles", []):
    role_data = {
      "project_name": project_name,
      "role_name": role.get("name"),
      "description": role.get("description", ""),
      "policies": role.get("policies", []),
      "groups": role.get("groups", []),
      "jwt_tokens": len(role.get("jwtTokens", [])),  # Don't include actual tokens
    }
    roles.append(role_data)

  return roles


async def process_project_entities(client: Client, argocd_client: ArgoCDClient, project_data: Dict[str, Any], job_id: str, datasource_id: str, batch_entities: List[StructuredEntity]) -> int:
  """
  Process entities for a single project and add them to the batch.
  Returns the count of entities processed.
  """
  project_name = project_data.get("metadata", {}).get("name", "unknown")
  logging.info(f"Processing project: {project_name}")

  entities_processed = 0

  try:
    # 1. Convert and add the Project entity itself
    filtered_project = utils.filter_nested_dict(project_data, IGNORE_FIELD_LIST)
    filtered_project["argocd_instance"] = argocd_instance_name  # type: ignore

    project_entity = StructuredEntity(
      entity_type="ArgoCDProject",
      all_properties=filtered_project,  # type: ignore
      primary_key_properties=["argocd_instance", "metadata.uid"],
      additional_key_properties=[["metadata.name"]],
    )
    batch_entities.append(project_entity)
    entities_processed += 1

    # 2. Extract and add Project Roles
    roles = extract_project_roles(project_data)
    for role in roles:
      role["argocd_instance"] = argocd_instance_name
      role_entity = StructuredEntity(entity_type="ArgoCDProjectRole", all_properties=role, primary_key_properties=["argocd_instance", "project_name", "role_name"], additional_key_properties=[["role_name"]])
      batch_entities.append(role_entity)
      entities_processed += 1

    # 3. Fetch and process Applications for this project
    applications = (await asyncio.to_thread(argocd_client.get_applications, projects=[project_name]))
    logging.info(f"  Found {len(applications)} applications in project {project_name}")

    for app in applications:
      try:
        filtered_app = utils.filter_nested_dict(app, IGNORE_FIELD_LIST)
        filtered_app["argocd_instance"] = argocd_instance_name  # type: ignore

        app_entity = StructuredEntity(
          entity_type="ArgoCDApplication",
          all_properties=filtered_app,  # type: ignore
          primary_key_properties=["argocd_instance", "metadata.uid"],
          additional_key_properties=[["metadata.name"], ["metadata.namespace", "metadata.name"]],
        )
        batch_entities.append(app_entity)
        entities_processed += 1
      except Exception as e:
        logging.error(f"  Error converting application to StructuredEntity: {e}", exc_info=True)
        await client.add_job_error(job_id, [f"Error converting application in project {project_name}: {str(e)}"])
        await client.increment_job_failure(job_id, 1)

    # 4. Fetch and process ApplicationSets for this project
    applicationsets = (await asyncio.to_thread(argocd_client.get_applicationsets, projects=[project_name]))
    logging.info(f"  Found {len(applicationsets)} applicationsets in project {project_name}")

    for appset in applicationsets:
      try:
        filtered_appset = utils.filter_nested_dict(appset, IGNORE_FIELD_LIST)
        filtered_appset["argocd_instance"] = argocd_instance_name  # type: ignore

        appset_entity = StructuredEntity(
          entity_type="ArgoCDApplicationSet",
          all_properties=filtered_appset,  # type: ignore
          primary_key_properties=["argocd_instance", "metadata.uid"],
          additional_key_properties=[["metadata.name"], ["metadata.namespace", "metadata.name"]],
        )
        batch_entities.append(appset_entity)
        entities_processed += 1
      except Exception as e:
        logging.error(f"  Error converting applicationset to StructuredEntity: {e}", exc_info=True)
        await client.add_job_error(job_id, [f"Error converting applicationset in project {project_name}: {str(e)}"])
        await client.increment_job_failure(job_id, 1)

    logging.info(f"  Processed {entities_processed} entities for project {project_name}")

  except Exception as e:
    error_msg = f"Error processing project {project_name}: {str(e)}"
    logging.error(error_msg, exc_info=True)
    await client.add_job_error(job_id, [error_msg])
    raise

  return entities_processed


async def sync_argocd_entities(client: Client):
  """
  Sync function that fetches ArgoCD entities and ingests them with job tracking.
  This function uses a streaming approach to minimize memory usage by:
  1. Processing one project at a time
  2. Batching entity ingestion
  3. Progressive job updates
  """
  logging.info("Starting ArgoCD v3 entity sync with optimized batching...")

  # Initialize ArgoCD client
  argocd_client = ArgoCDClient(SERVER_URL, ARGOCD_AUTH_TOKEN, ARGOCD_VERIFY_SSL)

  datasource_id = argocd_instance_name

  # 1. Create/Update the datasource
  datasource_info = DataSourceInfo(
    datasource_id=datasource_id,
    name=f"ArgoCD: {SERVER_URL}",
    ingestor_id=client.ingestor_id or "",
    description=f"ArgoCD v3 entities from {SERVER_URL}",
    source_type="argocdv3",
    last_updated=int(time.time()),
    default_chunk_size=0,  # Skip chunking for graph entities
    default_chunk_overlap=0,
    reload_interval=SYNC_INTERVAL,
    metadata={"argocd_url": SERVER_URL, "filter_projects": FILTER_PROJECTS, "verify_ssl": ARGOCD_VERIFY_SSL, "ignore_fields": IGNORE_FIELD_LIST},
  )
  async def sync_datasource() -> None:
    await client.upsert_datasource(datasource_info)
    logging.info(f"Created/updated datasource: {datasource_id}")

    # 2. Fetch projects first (needed for filtering)
    logging.info("Fetching projects...")
    projects_data = (await asyncio.to_thread(argocd_client.get_projects))

    # Apply project filter if specified
    if FILTER_PROJECTS:
      projects_data = [p for p in projects_data if p.get("metadata", {}).get("name") in FILTER_PROJECTS]
      logging.info(f"Filtered to {len(projects_data)} projects: {FILTER_PROJECTS}")

    # 3. Fetch global resources (not project-specific)
    logging.info("Fetching global resources (clusters, repositories)...")
    clusters_data = (await asyncio.to_thread(argocd_client.get_clusters))
    repositories_data = (await asyncio.to_thread(argocd_client.get_repositories))

    # 4. Estimate total items for job tracking
    # Note: This is an estimate since we fetch apps/appsets per project
    # We'll update the total as we discover more entities
    estimated_total = (
      1  # ArgoCDInstance
      + len(projects_data) * 10  # Estimate: ~10 entities per project (project + roles + apps + appsets)
      + len(clusters_data)
      + len(repositories_data)
    )

    logging.info(f"Estimated total entities to process: {estimated_total}")

    # 5. Create a job for this ingestion
    job_response = await client.create_job(datasource_id=datasource_id, job_status=JobStatus.IN_PROGRESS, message="Starting ArgoCD v3 entity ingestion with batching", total=estimated_total)
    job_id = job_response["job_id"]
    logging.info(f"Created job {job_id} for datasource={datasource_id}")

    # Get batch size from client configuration (considers both server and ingestor limits)
    INGEST_BATCH_SIZE = client.max_docs_per_ingest()
    logging.info(f"Using ingest batch size: {INGEST_BATCH_SIZE}")

    total_entities_processed = 0

    try:
      # 6. Create ArgoCDInstance entity first
      instance_entity = StructuredEntity(
        entity_type="ArgoCDInstance",
        all_properties={
          "server_url": SERVER_URL,
          "instance_name": argocd_instance_name,
          "verify_ssl": ARGOCD_VERIFY_SSL,
          "filtered_projects": FILTER_PROJECTS,
          "api_version": "v1",
        },
        primary_key_properties=["server_url"],
        additional_key_properties=[["instance_name"]],
      )

      # Start with instance entity in the batch
      current_batch: List[StructuredEntity] = [instance_entity]
      total_entities_processed += 1

      # 7. Process each project one at a time (streaming approach)
      logging.info(f"Processing {len(projects_data)} projects...")
      for idx, project_data in enumerate(projects_data, 1):
        project_name = project_data.get("metadata", {}).get("name", "unknown")
        logging.info(f"Processing project {idx}/{len(projects_data)}: {project_name}")

        try:
          # Process this project and add entities to current batch
          entities_added = await process_project_entities(client=client, argocd_client=argocd_client, project_data=project_data, job_id=job_id, datasource_id=datasource_id, batch_entities=current_batch)
          total_entities_processed += entities_added

          # If batch is large enough, ingest it and start a new batch
          if len(current_batch) >= INGEST_BATCH_SIZE:
            logging.info(f"Batch reached {len(current_batch)} entities, ingesting...")
            await client.ingest_entities(job_id=job_id, datasource_id=datasource_id, entities=current_batch, fresh_until=utils.get_fresh_until(SYNC_INTERVAL))
            await client.increment_job_progress(job_id, len(current_batch))
            logging.info(f"Ingested batch of {len(current_batch)} entities")

            # Start new batch
            current_batch = []

        except Exception as e:
          error_msg = f"Error processing project {project_name}: {str(e)}"
          logging.error(error_msg, exc_info=True)
          await client.add_job_error(job_id, [error_msg])
          # Continue with next project instead of failing entire job
          continue

      # 8. Process global resources (clusters and repositories)
      logging.info(f"Processing {len(clusters_data)} clusters...")
      for cluster in clusters_data:
        try:
          filtered_cluster = utils.filter_nested_dict(cluster, IGNORE_FIELD_LIST)
          filtered_cluster["argocd_instance"] = argocd_instance_name  # type: ignore

          cluster_entity = StructuredEntity(
            entity_type="ArgoCDCluster",
            all_properties=filtered_cluster,  # type: ignore
            primary_key_properties=["argocd_instance", "server"],
            additional_key_properties=[["name"]],
          )
          current_batch.append(cluster_entity)
          total_entities_processed += 1

          # Batch ingest if needed
          if len(current_batch) >= INGEST_BATCH_SIZE:
            await client.ingest_entities(job_id=job_id, datasource_id=datasource_id, entities=current_batch, fresh_until=utils.get_fresh_until(SYNC_INTERVAL))
            await client.increment_job_progress(job_id, len(current_batch))
            logging.info(f"Ingested batch of {len(current_batch)} entities")
            current_batch = []

        except Exception as e:
          logging.error(f"Error converting cluster to StructuredEntity: {e}", exc_info=True)
          await client.add_job_error(job_id, [f"Error converting cluster: {str(e)}"])
          await client.increment_job_failure(job_id, 1)

      logging.info(f"Processing {len(repositories_data)} repositories...")
      for repo in repositories_data:
        try:
          filtered_repo = utils.filter_nested_dict(repo, IGNORE_FIELD_LIST)
          filtered_repo["argocd_instance"] = argocd_instance_name  # type: ignore

          repo_entity = StructuredEntity(
            entity_type="ArgoCDRepository",
            all_properties=filtered_repo,  # type: ignore
            primary_key_properties=["argocd_instance", "repo"],
            additional_key_properties=[["name"]],
          )
          current_batch.append(repo_entity)
          total_entities_processed += 1

          # Batch ingest if needed
          if len(current_batch) >= INGEST_BATCH_SIZE:
            await client.ingest_entities(job_id=job_id, datasource_id=datasource_id, entities=current_batch, fresh_until=utils.get_fresh_until(SYNC_INTERVAL))
            await client.increment_job_progress(job_id, len(current_batch))
            logging.info(f"Ingested batch of {len(current_batch)} entities")
            current_batch = []

        except Exception as e:
          logging.error(f"Error converting repository to StructuredEntity: {e}", exc_info=True)
          await client.add_job_error(job_id, [f"Error converting repository: {str(e)}"])
          await client.increment_job_failure(job_id, 1)

      # 9. Ingest any remaining entities in the final batch
      if current_batch:
        logging.info(f"Ingesting final batch of {len(current_batch)} entities...")
        await client.ingest_entities(job_id=job_id, datasource_id=datasource_id, entities=current_batch, fresh_until=utils.get_fresh_until(SYNC_INTERVAL))
        await client.increment_job_progress(job_id, len(current_batch))
        logging.info(f"Ingested final batch of {len(current_batch)} entities")

      # 10. Mark job as complete
      await client.update_job(job_id=job_id, job_status=JobStatus.COMPLETED, message=f"Successfully ingested {total_entities_processed} entities using streaming approach")
      logging.info(f"Successfully completed ingestion of {total_entities_processed} entities")

    except Exception as e:
      # Mark job as failed
      error_msg = f"StructuredEntity ingestion failed: {str(e)}"
      await client.add_job_error(job_id, [error_msg])
      await client.update_job(job_id=job_id, job_status=JobStatus.FAILED, message=error_msg)
      logging.error(error_msg, exc_info=True)
      raise

  await run_standalone_ingestion(datasource_info.datasource_id, sync_datasource)


if __name__ == "__main__":
  try:
    logging.info("Starting ArgoCD v3 ingestor using IngestorBuilder...")

    # Use IngestorBuilder for simplified ingestor creation
    IngestorBuilder().name(argocd_instance_name).type("argocdv3").description(f"Ingestor for ArgoCD v3 entities from {SERVER_URL}").metadata(
      {"argocd_url": SERVER_URL, "filter_projects": FILTER_PROJECTS, "verify_ssl": ARGOCD_VERIFY_SSL, "sync_interval": SYNC_INTERVAL, "api_version": "v1", "ignore_fields": IGNORE_FIELD_LIST}
    ).sync_with_fn(sync_argocd_entities).every(SYNC_INTERVAL).with_init_delay(int(os.getenv("INIT_DELAY_SECONDS", "0"))).run()

  except KeyboardInterrupt:
    logging.info("ArgoCD v3 ingestor execution interrupted by user")
  except Exception as e:
    logging.error(f"ArgoCD v3 ingestor failed: {e}", exc_info=True)
