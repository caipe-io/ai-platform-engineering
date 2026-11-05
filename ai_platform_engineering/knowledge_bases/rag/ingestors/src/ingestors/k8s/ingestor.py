import os
import asyncio
import time
import logging
from typing import List, Dict, Any, Set

from common.ingestor_listener import run_standalone_ingestion
from common.ingestor import IngestorBuilder, Client
from common.models.rag import StructuredEntity
from common.models.rag import DataSourceInfo
from common.job_manager import JobStatus
import common.utils as utils

from kubernetes import dynamic
from kubernetes import config as kconfig
from kubernetes.dynamic.exceptions import NotFoundError, ApiException
from kubernetes.dynamic import Resource

"""
Kubernetes Ingestor - Ingests Kubernetes resources as graph entities into the RAG system.
Uses the IngestorBuilder pattern for simplified ingestor creation with automatic job management and batching.

Supports both standard Kubernetes resources and Custom Resource Definitions (CRDs).

Configuration Modes:
1. In-Cluster Mode: Set IN_CLUSTER=true to run inside a Kubernetes pod using ServiceAccount credentials
2. Custom Kubeconfig: Set KUBECONFIG=/path/to/config and optionally KUBE_CONTEXT=context-name
3. Default Kubeconfig: Use ~/.kube/config with optional KUBE_CONTEXT=context-name
"""

LOG_LEVEL = os.environ.get("LOG_LEVEL", "INFO").upper()
logging.basicConfig(level=LOG_LEVEL)

# Configuration
CLUSTER_NAME = os.environ.get("CLUSTER_NAME")
if not CLUSTER_NAME:
  raise ValueError("CLUSTER_NAME environment variable must be set")
SYNC_INTERVAL = int(os.getenv("SYNC_INTERVAL", 86400))  # sync every day by default

# Kubernetes configuration options
KUBECONFIG_PATH = os.environ.get("KUBECONFIG")  # Custom kubeconfig file path
KUBE_CONTEXT = os.environ.get("KUBE_CONTEXT")  # Specific context to use
IN_CLUSTER = os.environ.get("IN_CLUSTER", "false").lower() == "true"  # Run in-cluster mode

# Resource filtering
default_resource_list = "Certificate,ClusterIssuer,CronJob,DaemonSet,Deployment,Ingress,IngressClass,Issuer,Job,Namespace,Node,Service,StatefulSet,StorageClass"
resource_list_str = os.environ.get("RESOURCE_LIST", default_resource_list)
RESOURCE_LIST: Set[str] = set([r.strip().lower() for r in resource_list_str.split(",")])

# Field filtering - fields to ignore from resource manifests
default_ignore_field_list = "metadata.annotations.kubectl.kubernetes.io,metadata.labels.app.kubernetes.io,metadata.managedFields,metadata.selfLink"
ignore_field_list_str = os.environ.get("IGNORE_FIELD_LIST", default_ignore_field_list)
IGNORE_FIELD_LIST: List[str] = [f.strip() for f in ignore_field_list_str.split(",")]

# Validate cluster name
if not CLUSTER_NAME:
  raise ValueError("CLUSTER_NAME environment variable must be set")


def normalize_k8s_kind_to_entity_type(kind: str) -> str:
  """
  Convert Kubernetes resource kind to Neo4j-friendly entity type in Pascal case.

  Examples:
      Deployment -> K8sDeployment
      StatefulSet -> K8sStatefulSet
      my-custom-resource -> K8sMyCustomResource

  Args:
      kind: Kubernetes resource kind

  Returns:
      Pascal case entity type with K8s prefix
  """
  # Handle hyphenated names (common in CRDs)
  if "-" in kind:
    parts = kind.split("-")
    pascal_parts = [part.capitalize() for part in parts]
    kind = "".join(pascal_parts)
  elif not kind[0].isupper():
    # Ensure first letter is capitalized
    kind = kind.capitalize()

  return f"K8s{kind}"


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


def determine_primary_key_properties(resource_dict: Dict[str, Any]) -> List[str]:
  """
  Determine primary key properties for a K8s resource.
  Namespaced resources use cluster_name, namespace, and name.
  Cluster-scoped resources use cluster_name and name.

  Args:
      resource_dict: Resource dictionary (nested structure)

  Returns:
      List of primary key property names
  """
  # Check if resource has namespace in nested structure
  metadata = resource_dict.get("metadata", {})
  if metadata.get("namespace"):
    return ["cluster_name", "metadata.namespace", "metadata.name"]
  else:
    return ["cluster_name", "metadata.name"]


async def ensure_cluster_entity_exists(client: Client, cluster_name: str, datasource_id: str, job_id: str):
  """
  Ensure the K8s cluster entity exists in the graph database.
  The graph database will handle deduplication if the entity already exists.

  Args:
      client: RAG client instance
      cluster_name: Name of the Kubernetes cluster
      datasource_id: Datasource ID
      job_id: Current job ID for error tracking
  """
  try:
    logging.info(f"Ingesting K8sCluster entity for cluster: {cluster_name}")

    cluster_entity = StructuredEntity(entity_type="K8sCluster", primary_key_properties=["name"], all_properties={"name": cluster_name})

    await client.ingest_entities(job_id=job_id, datasource_id=datasource_id, entities=[cluster_entity], fresh_until=utils.get_fresh_until(SYNC_INTERVAL))
    logging.info(f"Ingested K8sCluster entity: {cluster_name}")

  except Exception as e:
    logging.warning(f"Could not ingest cluster entity: {e}")
    # Non-fatal error - continue with resource ingestion


def load_kubernetes_config():
  """
  Load Kubernetes configuration based on environment settings.
  Supports three modes:
  1. In-cluster configuration (IN_CLUSTER=true)
  2. Custom kubeconfig file with optional context (KUBECONFIG and KUBE_CONTEXT)
  3. Default kubeconfig (~/.kube/config) with optional context (KUBE_CONTEXT only)

  Returns:
      None (configuration is loaded globally)

  Raises:
      Exception: If configuration cannot be loaded
  """
  try:
    if IN_CLUSTER:
      # Load in-cluster configuration
      logging.info("Loading in-cluster Kubernetes configuration")
      kconfig.load_incluster_config()
      logging.info("Successfully loaded in-cluster Kubernetes configuration")
    elif KUBECONFIG_PATH:
      # Load from custom kubeconfig file
      if KUBE_CONTEXT:
        logging.info(f"Loading Kubernetes configuration from {KUBECONFIG_PATH} with context {KUBE_CONTEXT}")
        kconfig.load_kube_config(config_file=KUBECONFIG_PATH, context=KUBE_CONTEXT)
        logging.info(f"Successfully loaded kubeconfig from {KUBECONFIG_PATH} using context {KUBE_CONTEXT}")
      else:
        logging.info(f"Loading Kubernetes configuration from {KUBECONFIG_PATH}")
        kconfig.load_kube_config(config_file=KUBECONFIG_PATH)
        logging.info(f"Successfully loaded kubeconfig from {KUBECONFIG_PATH}")
    else:
      # Load from default kubeconfig location
      if KUBE_CONTEXT:
        logging.info(f"Loading Kubernetes configuration with context {KUBE_CONTEXT}")
        kconfig.load_kube_config(context=KUBE_CONTEXT)
        logging.info(f"Successfully loaded default kubeconfig using context {KUBE_CONTEXT}")
      else:
        logging.info("Loading Kubernetes configuration from default kubeconfig")
        kconfig.load_kube_config()
        logging.info("Successfully loaded default kubeconfig")
  except Exception as e:
    logging.error(f"Failed to load Kubernetes configuration: {e}")
    raise


async def sync_k8s_resources(client: Client):
  """
  Main sync function that orchestrates Kubernetes resource ingestion.
  This function is called periodically by the IngestorBuilder.
  """
  logging.info(f"Starting Kubernetes resource sync for cluster: {CLUSTER_NAME}")

  # Load Kubernetes configuration based on environment settings
  load_kubernetes_config()

  # Create datasource
  datasource_id = f"k8s-cluster-{CLUSTER_NAME}"
  datasource_info = DataSourceInfo(
    datasource_id=datasource_id,
    name=f"Kubernetes: {CLUSTER_NAME}",
    ingestor_id=client.ingestor_id or "",
    description=f"Kubernetes resources for cluster {CLUSTER_NAME}",
    source_type="kubernetes",
    last_updated=int(time.time()),
    default_chunk_size=0,  # Skip chunking for graph entities
    default_chunk_overlap=0,
    reload_interval=SYNC_INTERVAL,
    metadata={
      "cluster_name": CLUSTER_NAME,
      "resource_types": list(RESOURCE_LIST),
    },
  )
  async def sync_datasource() -> None:
    await client.upsert_datasource(datasource_info)
    logging.info(f"Created/updated datasource: {datasource_id}")

    # Create job - we'll update total count once we discover all resources
    job_response = await client.create_job(
      datasource_id=datasource_id,
      job_status=JobStatus.IN_PROGRESS,
      message=f"Starting Kubernetes resource sync for cluster {CLUSTER_NAME}",
      total=0,  # Will be updated as we discover resources
    )
    job_id = job_response["job_id"]
    logging.info(f"Created job {job_id}")

    try:
      # Ensure cluster entity exists
      await ensure_cluster_entity_exists(client, CLUSTER_NAME, datasource_id, job_id)

      # Initialize dynamic client
      dyn_client = dynamic.DynamicClient((await asyncio.to_thread(kconfig.new_client_from_config)))

      # Discover all available API resources
      api_resources = dyn_client.resources

      # Collect all entities to ingest
      all_entities = []
      processed_kinds = set()
      skipped_kinds = set()

      # Iterate through all resource types
      for resource_group in await asyncio.to_thread(list, api_resources):
        try:
          resource: Resource = resource_group[0]

          # Skip invalid resources
          if not isinstance(resource, Resource) or resource.kind is None:
            continue

          kind_lower = resource.kind.lower()

          # Skip if not in allowed resource list
          if kind_lower not in RESOURCE_LIST:
            if kind_lower not in skipped_kinds:
              logging.debug(f"Skipping resource type not in RESOURCE_LIST: {resource.kind}")
              skipped_kinds.add(kind_lower)
            continue

          processed_kinds.add(kind_lower)

          resource_group_version = f"{resource.group}/{resource.api_version}" if resource.group else resource.api_version
          logging.info(f"Fetching {resource.kind} resources (API: {resource_group_version})")

          # Fetch all objects of this resource type
          try:
            objects = (await asyncio.to_thread(resource.get))
          except (NotFoundError, ApiException) as e:
            logging.warning(f"Cannot access {resource.kind}: {e}")
            continue

          # Convert each object to an StructuredEntity
          for obj in objects.items:
            try:
              # Generate unique identifier for logging
              namespace = obj.metadata.get("namespace", "")
              name = obj.metadata.get("name", "")
              resource_id = f"{CLUSTER_NAME}/{resource_group_version}/{resource.kind}/{namespace}/{name}"

              logging.debug(f"Processing {resource.kind}: {resource_id}")

              # Filter ignored fields while preserving nested structure
              resource_dict = obj.to_dict()
              filtered_resource = utils.filter_nested_dict(resource_dict, IGNORE_FIELD_LIST)

              # Add cluster name to properties
              filtered_resource["cluster_name"] = CLUSTER_NAME  # type: ignore

              # Determine primary key properties based on namespace
              primary_key_props = determine_primary_key_properties(filtered_resource)  # type: ignore

              # Determine additional key properties for alternate lookups
              additional_keys = []
              metadata = filtered_resource.get("metadata", {})
              if metadata.get("uid"):
                additional_keys.append(["cluster_name", "metadata.uid"])

              # Create StructuredEntity
              entity = StructuredEntity(entity_type=normalize_k8s_kind_to_entity_type(resource.kind), primary_key_properties=primary_key_props, additional_key_properties=additional_keys, all_properties=filtered_resource)
              all_entities.append(entity)

            except Exception as e:
              error_msg = f"Error processing {resource.kind} object {name}: {str(e)}"
              logging.error(error_msg, exc_info=True)
              await client.add_job_error(job_id, [error_msg])
              await client.increment_job_failure(job_id, 1)
              continue

          logging.info(f"Collected {len(objects.items)} {resource.kind} resources")

        except Exception as e:
          logging.error(f"Error processing resource group: {e}", exc_info=True)
          continue

      # Update job with total count
      await client.update_job(job_id=job_id, total=len(all_entities), message=f"Discovered {len(all_entities)} resources across {len(processed_kinds)} types")

      logging.info(f"Discovered {len(all_entities)} total resources across {len(processed_kinds)} resource types")

      # Ingest all entities with automatic batching
      if all_entities:
        logging.info(f"Ingesting {len(all_entities)} entities with automatic batching")

        await client.ingest_entities(job_id=job_id, datasource_id=datasource_id, entities=all_entities, fresh_until=utils.get_fresh_until(SYNC_INTERVAL))

        # Update progress
        await client.increment_job_progress(job_id, len(all_entities))

        # Mark job as completed
        await client.update_job(job_id=job_id, job_status=JobStatus.COMPLETED, message=f"Successfully synced {len(all_entities)} K8s resources from {len(processed_kinds)} resource types")
        logging.info(f"Successfully completed K8s resource sync: {len(all_entities)} entities")
      else:
        # No resources found
        await client.update_job(job_id=job_id, job_status=JobStatus.COMPLETED, message="No Kubernetes resources found matching configured filters")
        logging.info("No resources to ingest")

    except Exception as e:
      error_msg = f"Kubernetes resource sync failed: {str(e)}"
      await client.add_job_error(job_id, [error_msg])
      await client.update_job(job_id=job_id, job_status=JobStatus.FAILED, message=error_msg)
      logging.error(error_msg, exc_info=True)
      raise

  await run_standalone_ingestion(datasource_info.datasource_id, sync_datasource)


if __name__ == "__main__":
  try:
    logging.info("Starting Kubernetes ingestor using IngestorBuilder...")

    # Use IngestorBuilder for simplified ingestor creation
    IngestorBuilder().name(f"k8s_ingestor_{CLUSTER_NAME}").type("kubernetes").description(f"Ingestor for Kubernetes cluster {CLUSTER_NAME}").metadata(
      {
        "cluster_name": CLUSTER_NAME,
        "resource_types": list(RESOURCE_LIST),
        "sync_interval": SYNC_INTERVAL,
      }
    ).sync_with_fn(sync_k8s_resources).every(SYNC_INTERVAL).with_init_delay(int(os.getenv("INIT_DELAY_SECONDS", "0"))).run()

  except KeyboardInterrupt:
    logging.info("Kubernetes ingestor execution interrupted by user")
  except Exception as e:
    logging.error(f"Kubernetes ingestor failed: {e}", exc_info=True)
