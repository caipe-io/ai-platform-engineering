import os
import time
import logging
import asyncio
import configparser
import tempfile
import boto3
from typing import List, Any, Dict, Optional

from common.ingestor_listener import run_standalone_ingestion
from common.ingestor import IngestorBuilder, Client
from common.models.rag import StructuredEntity
from common.models.rag import DataSourceInfo
from common.job_manager import JobStatus
import common.utils as utils

"""
AWS Ingestor - Ingests AWS resources as graph entities into the RAG system.
Uses the IngestorBuilder pattern for simplified ingestor creation with automatic job management and batching.

Supports multi-account ingestion via AWS_ACCOUNT_LIST env var, using the same format
as the AWS agent. Each account becomes a separate datasource. When AWS_ACCOUNT_LIST
is not set, falls back to single-account mode using default credentials.

Supported resource types:
- iam:user - IAM Users
- ec2:instance - EC2 Instances
- ec2:volume - EBS Volumes
- ec2:natgateway - NAT Gateways
- ec2:vpc - VPCs
- ec2:subnet - Subnets
- ec2:security-group - Security Groups
- eks:cluster - EKS Clusters
- s3:bucket - S3 Buckets
- elasticloadbalancing:loadbalancer - Load Balancers (ALB/NLB/CLB)
- route53:hostedzone - Route53 Hosted Zones
- rds:db - RDS Database Instances
- lambda:function - Lambda Functions
- dynamodb:table - DynamoDB Tables
"""

LOG_LEVEL = os.environ.get("LOG_LEVEL", "INFO").upper()
logging.basicConfig(level=LOG_LEVEL)

# Configuration
SYNC_INTERVAL = int(os.getenv("SYNC_INTERVAL", 86400))  # sync every day by default
default_resource_types = "iam:user,ec2:instance,ec2:volume,ec2:natgateway,ec2:vpc,ec2:subnet,ec2:security-group,eks:cluster,s3:bucket,elasticloadbalancing:loadbalancer,route53:hostedzone,rds:db,lambda:function,dynamodb:table"
RESOURCE_TYPES = os.environ.get("RESOURCE_TYPES", default_resource_types).split(",")
# AWS Region - check both AWS_REGION and AWS_DEFAULT_REGION (boto3 default)
AWS_REGION = os.environ.get("AWS_REGION") or os.environ.get("AWS_DEFAULT_REGION") or "us-east-2"

# Multi-account configuration (same format as AWS agent)
# Format: "name1:id1,name2:id2,..." e.g. "prod:123456789012,staging:234567890123"
AWS_ACCOUNT_LIST = os.environ.get("AWS_ACCOUNT_LIST", "")
CROSS_ACCOUNT_ROLE_NAME = os.environ.get("CROSS_ACCOUNT_ROLE_NAME", "caipe-read-only")

# Resource type configuration - defines how to fetch and process each resource type
RESOURCE_CONFIG = {
  "ec2:instance": {"fetch_fn": "get_ec2_details", "primary_key": ["Arn"], "additional_keys": [["InstanceId"], ["PrivateDnsName"], ["PrivateIpAddress"], ["PublicDnsName"], ["PublicIpAddress"]], "regional": True},
  "eks:cluster": {"fetch_fn": "get_eks_details", "primary_key": ["arn"], "additional_keys": [["name"], ["endpoint"]], "regional": True},
  "s3:bucket": {"fetch_fn": "get_s3_details", "primary_key": ["Arn"], "additional_keys": [["BucketName"]], "regional": True},
  "elasticloadbalancing:loadbalancer": {"fetch_fn": "get_elb_details", "primary_key": ["LoadBalancerArn"], "additional_keys": [["LoadBalancerName"], ["DNSName"]], "regional": True},
  "ec2:volume": {"fetch_fn": "get_ebs_details", "primary_key": ["Arn"], "additional_keys": [["VolumeId"]], "regional": True},
  "route53:hostedzone": {
    "fetch_fn": "get_route53_hostedzone_details",
    "primary_key": ["Arn"],
    "additional_keys": [["ZoneId"]],
    "regional": False,  # Route53 is global
  },
  "iam:user": {
    "fetch_fn": "list_iam_users",
    "primary_key": ["Arn"],
    "additional_keys": [["UserName"], ["UserId"]],
    "regional": False,  # IAM is global
  },
  "ec2:natgateway": {"fetch_fn": "get_natgateway_details", "primary_key": ["Arn"], "additional_keys": [["NatGatewayId"]], "regional": True},
  "ec2:vpc": {"fetch_fn": "get_vpc_details", "primary_key": ["Arn"], "additional_keys": [["VpcId"], ["CidrBlock"]], "regional": True},
  "ec2:subnet": {"fetch_fn": "get_subnet_details", "primary_key": ["Arn"], "additional_keys": [["SubnetId"], ["CidrBlock"]], "regional": True},
  "ec2:security-group": {"fetch_fn": "get_security_group_details", "primary_key": ["Arn"], "additional_keys": [["GroupId"], ["GroupName"]], "regional": True},
  "rds:db": {"fetch_fn": "get_rds_details", "primary_key": ["DBInstanceArn"], "additional_keys": [["DBInstanceIdentifier"], ["Endpoint.Address"]], "regional": True},
  "lambda:function": {"fetch_fn": "get_lambda_details", "primary_key": ["FunctionArn"], "additional_keys": [["FunctionName"]], "regional": True},
  "dynamodb:table": {"fetch_fn": "get_dynamodb_details", "primary_key": ["TableArn"], "additional_keys": [["TableName"]], "regional": True},
}


# ============================================================================
# Multi-Account Configuration
# ============================================================================


def parse_account_list() -> List[Dict[str, str]]:
  """
  Parse AWS_ACCOUNT_LIST env var into a list of account dicts.

  Format: "name1:id1,name2:id2,..." (same as AWS agent)
  If no colon, the entry is treated as both name and ID.

  Returns:
      List of dicts with 'name' and 'id' keys. Empty list if not configured.
  """
  if not AWS_ACCOUNT_LIST:
    return []

  accounts = []
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


def setup_aws_profiles(accounts: List[Dict[str, str]]) -> None:
  """
  Generate AWS config profiles for cross-account access when needed.

  If a profile already exists in ~/.aws/credentials (direct credentials),
  no config entry is generated — boto3 will use the credentials directly.

  For profiles without direct credentials, generates assume-role config using
  role_arn + credential_source=Environment, so boto3 will transparently
  perform STS AssumeRole using the base credentials from env vars.

  Same approach as the AWS agent (agent_aws/tools.py:setup_aws_profiles).

  Args:
      accounts: List of account dicts with 'name' and 'id' keys.
  """
  if not accounts:
    return

  # Check which profiles already have direct credentials
  existing_profiles: set[str] = set()
  credentials_file = os.path.expanduser("~/.aws/credentials")
  if os.path.exists(credentials_file):
    creds_parser = configparser.ConfigParser()
    creds_parser.read(credentials_file)
    existing_profiles = set(creds_parser.sections())

  # Only generate config for profiles that need cross-account role assumption
  needs_config = [acc for acc in accounts if acc["name"] not in existing_profiles]

  if existing_profiles:
    has_direct = [acc["name"] for acc in accounts if acc["name"] in existing_profiles]
    if has_direct:
      logging.info(f"Profiles with direct credentials (no config needed): {has_direct}")

  if not needs_config:
    logging.info(f"All {len(accounts)} profiles have direct credentials, skipping config generation")
    return

  # Write to a temp directory to avoid permission issues with mounted ~/.aws
  aws_config_dir = tempfile.mkdtemp(prefix="aws_config_")
  aws_config_file = os.path.join(aws_config_dir, "config")

  # Tell boto3 to use this config file
  os.environ["AWS_CONFIG_FILE"] = aws_config_file

  profile_sections = ["# AUTO-GENERATED PROFILES FROM AWS_ACCOUNT_LIST"]
  profile_sections.append("# Regenerated at ingestor startup - do not edit manually\n")

  for acc in needs_config:
    profile_section = f"""[profile {acc["name"]}]
role_arn = arn:aws:iam::{acc["id"]}:role/{CROSS_ACCOUNT_ROLE_NAME}
credential_source = Environment
"""
    profile_sections.append(profile_section)

  with open(aws_config_file, "w") as f:
    f.write("\n".join(profile_sections))

  logging.info(f"Generated AWS config for {len(needs_config)} accounts needing role assumption: {[a['name'] for a in needs_config]}")


def create_session(profile_name: Optional[str] = None) -> boto3.Session:
  """
  Create a boto3 session, optionally with a named profile for cross-account access.

  Args:
      profile_name: AWS profile name from ~/.aws/config. If None, uses default credentials.

  Returns:
      boto3.Session configured for the target account.
  """
  if profile_name:
    return boto3.Session(profile_name=profile_name, region_name=AWS_REGION)
  return boto3.Session(region_name=AWS_REGION)


# ============================================================================
# AWS API Helpers
# ============================================================================


async def get_account_id(session: boto3.Session) -> str:
  """Get AWS account ID using the given session."""
  sts_client = session.client("sts", region_name=AWS_REGION)
  return (await asyncio.to_thread(sts_client.get_caller_identity))["Account"]


async def get_all_regions(session: boto3.Session) -> List[str]:
  """
  Fetch all AWS regions using the EC2 client.

  Args:
      session: boto3 session for the target account.

  Returns:
      list: A list of all AWS regions.
  """
  ec2_client = session.client("ec2", region_name=AWS_REGION)
  try:
    response = (await asyncio.to_thread(ec2_client.describe_regions))
    regions = [region["RegionName"] for region in response["Regions"]]
    return regions
  except Exception as e:
    logging.error(f"Error fetching regions: {e}")
    return []


async def fetch_resources(session: boto3.Session, resource_type: str, region: str) -> List[str]:
  """
  Fetches the resource inventory for the specified resource types using tagging APIs.

  Parameters:
      session (boto3.Session): boto3 session for the target account.
      resource_type (str): The type of AWS resource to fetch (e.g. 'ec2:instance', 's3:bucket', etc.).
      region (str): The AWS region to fetch resources from.

  Returns:
      List[str]: A list of ARNs for the specified resource type in the given region.
  """
  tagging_client = session.client("resourcegroupstaggingapi", region_name=region)
  paginator = tagging_client.get_paginator("get_resources")
  response_iterator = paginator.paginate(ResourceTypeFilters=[resource_type])

  resource_arns = []
  for page in await asyncio.to_thread(list, response_iterator):
    for resource in page.get("ResourceTagMappingList", []):
      resource_arns.append(resource["ResourceARN"])

  return resource_arns


# ============================================================================
# Resource Detail Fetchers
# ============================================================================


async def get_ec2_details(session: boto3.Session, resource_arns: List[str], region: str) -> List[Dict[str, Any]]:
  """Fetch details for EC2 instances given their ARNs."""
  if not resource_arns:
    return []

  ec2_client = session.client("ec2", region_name=region)
  instance_id_arn_map = {arn.split("/")[-1]: arn for arn in resource_arns}
  instance_ids = list(instance_id_arn_map.keys())

  try:
    response = (await asyncio.to_thread(ec2_client.describe_instances, InstanceIds=instance_ids))
    ec2_instances = []
    for reservation in response["Reservations"]:
      for instance in reservation["Instances"]:
        instance_id = instance["InstanceId"]
        instance["Arn"] = instance_id_arn_map.get(instance_id, "")
        if not instance["Arn"]:
          logging.warning(f"No ARN found for instance {instance_id}")
          continue
        ec2_instances.append(instance)
    return ec2_instances
  except Exception as e:
    logging.error(f"Error fetching EC2 instance details: {e}")
    return []


async def get_eks_details(session: boto3.Session, resource_arns: List[str], region: str) -> List[Dict[str, Any]]:
  """Fetch details for EKS clusters given their ARNs."""
  if not resource_arns:
    return []

  eks_client = session.client("eks", region_name=region)
  cluster_names = [arn.split("/")[-1] for arn in resource_arns]

  clusters = []
  for cluster_name in cluster_names:
    logging.debug(f"Fetching details for EKS cluster: {cluster_name}")
    try:
      response = (await asyncio.to_thread(eks_client.describe_cluster, name=cluster_name))
      clusters.append(response["cluster"])
    except Exception as e:
      logging.error(f"Error fetching details for EKS cluster {cluster_name}: {e}")
  return clusters


async def get_s3_details(session: boto3.Session, resource_arns: List[str], region: str) -> List[Dict[str, Any]]:
  """Fetch details for S3 buckets given their ARNs."""
  if not resource_arns:
    return []

  s3_client = session.client("s3", region_name=region)
  buckets = []

  for arn in resource_arns:
    bucket_name = arn.split(":::")[-1]
    if not bucket_name:
      continue

    logging.debug(f"Fetching details for S3 bucket: {bucket_name}")
    try:
      bucket_data: Dict[str, Any] = {
        "Arn": arn,
        "BucketName": bucket_name,
      }

      # Try to fetch encryption config
      try:
        bucket_data["Encryption"] = (await asyncio.to_thread(s3_client.get_bucket_encryption, Bucket=bucket_name)).get("ServerSideEncryptionConfiguration", {})
      except s3_client.exceptions.ServerSideEncryptionConfigurationNotFoundError:
        bucket_data["Encryption"] = {}
      except Exception as e:
        logging.warning(f"Could not fetch encryption for bucket {bucket_name}: {e}")

      # Try to fetch tags
      try:
        bucket_data["Tagging"] = (await asyncio.to_thread(s3_client.get_bucket_tagging, Bucket=bucket_name)).get("TagSet", [])
      except s3_client.exceptions.NoSuchTagSet:
        bucket_data["Tagging"] = []
      except Exception as e:
        logging.warning(f"Could not fetch tags for bucket {bucket_name}: {e}")

      buckets.append(bucket_data)
    except Exception as e:
      logging.error(f"Error fetching details for S3 bucket {bucket_name}: {e}")

  return buckets


async def get_elb_details(session: boto3.Session, resource_arns: List[str], region: str) -> List[Dict[str, Any]]:
  """Fetch details for all Load Balancers (ALB/NLB/CLB) given their ARNs."""
  if not resource_arns:
    return []

  # Split ARNs into ELBv2 (ALB/NLB) and Classic Load Balancers
  elbv2_arns = [arn for arn in resource_arns if len(arn.split("loadbalancer/")[-1].split("/")) > 1]
  clb_arns = [arn for arn in resource_arns if len(arn.split("loadbalancer/")[-1].split("/")) == 1]

  elbs = []

  # Fetch ELBv2 details (ALB/NLB)
  if elbv2_arns:
    logging.debug(f"Fetching {len(elbv2_arns)} ALB/NLB in region {region}")
    try:
      elbv2_client = session.client("elbv2", region_name=region)
      response = (await asyncio.to_thread(elbv2_client.describe_load_balancers, LoadBalancerArns=elbv2_arns))
      for lb in response["LoadBalancers"]:
        # Ensure LoadBalancerArn is present for consistency
        if "LoadBalancerArn" not in lb:
          lb["LoadBalancerArn"] = lb.get("Arn", "")
        elbs.append(lb)
    except Exception as e:
      logging.error(f"Error fetching ELBv2 details: {e}")

  # Fetch Classic Load Balancer details
  if clb_arns:
    logging.debug(f"Fetching {len(clb_arns)} Classic ELB in region {region}")
    try:
      elb_client = session.client("elb", region_name=region)
      lb_names = [arn.split("/")[-1] for arn in clb_arns]
      lb_name_arn_map = {name: arn for name, arn in zip(lb_names, clb_arns)}

      response = (await asyncio.to_thread(elb_client.describe_load_balancers, LoadBalancerNames=lb_names))
      for lb in response["LoadBalancerDescriptions"]:
        lb_name = lb.get("LoadBalancerName", "")
        # Add ARN for consistency
        lb["LoadBalancerArn"] = lb_name_arn_map.get(lb_name, "")
        elbs.append(lb)
    except Exception as e:
      logging.error(f"Error fetching Classic Load Balancer details: {e}")

  return elbs


async def get_ebs_details(session: boto3.Session, resource_arns: List[str], region: str) -> List[Dict[str, Any]]:
  """Fetch details for EBS volumes given their ARNs."""
  if not resource_arns:
    return []

  ec2_client = session.client("ec2", region_name=region)
  volume_id_arn_map = {arn.split("/")[-1]: arn for arn in resource_arns}
  volume_ids = list(volume_id_arn_map.keys())

  try:
    response = (await asyncio.to_thread(ec2_client.describe_volumes, VolumeIds=volume_ids))
    volumes = []
    for volume in response["Volumes"]:
      volume["Arn"] = volume_id_arn_map[volume["VolumeId"]]
      volumes.append(volume)
    return volumes
  except Exception as e:
    logging.error(f"Error fetching EBS volume details: {e}")
    return []


async def get_route53_hostedzone_details(session: boto3.Session, resource_arns: List[str], region: str) -> List[Dict[str, Any]]:
  """Fetch details for Route 53 hosted zones given their ARNs."""
  if not resource_arns:
    return []

  route53_client = session.client("route53", region_name="us-east-1")  # Route53 is global
  zones = []

  for arn in resource_arns:
    hosted_zone_id = arn.split("/")[-1]
    if not hosted_zone_id:
      continue

    try:
      response = (await asyncio.to_thread(route53_client.get_hosted_zone, Id=hosted_zone_id))
      zone = response["HostedZone"]
      zone["Arn"] = arn
      zone["ZoneId"] = hosted_zone_id
      zones.append(zone)
    except Exception as e:
      logging.error(f"Error fetching Route53 hosted zone {hosted_zone_id}: {e}")

  return zones


async def list_iam_users(session: boto3.Session, resource_arns: Optional[List[str]] = None, region: Optional[str] = None) -> List[Dict[str, Any]]:
  """List all IAM users in the AWS account."""
  iam_client = session.client("iam")

  try:
    response = (await asyncio.to_thread(iam_client.list_users))
    users = response.get("Users", [])

    if not users:
      logging.info("No IAM users found in AWS account")
      return []

    return users
  except Exception as e:
    logging.error(f"Error listing IAM users: {e}")
    return []


async def get_natgateway_details(session: boto3.Session, resource_arns: List[str], region: str) -> List[Dict[str, Any]]:
  """Fetch details for NAT Gateways given their ARNs."""
  if not resource_arns:
    return []

  ec2_client = session.client("ec2", region_name=region)
  natgateway_id_arn_map = {arn.split("/")[-1]: arn for arn in resource_arns}
  natgateway_ids = list(natgateway_id_arn_map.keys())

  try:
    response = (await asyncio.to_thread(ec2_client.describe_nat_gateways, NatGatewayIds=natgateway_ids))
    natgateways = []
    for natgateway in response["NatGateways"]:
      natgateway["Arn"] = natgateway_id_arn_map[natgateway["NatGatewayId"]]
      natgateways.append(natgateway)
    return natgateways
  except Exception as e:
    logging.error(f"Error fetching NAT Gateway details: {e}")
    return []


async def get_vpc_details(session: boto3.Session, resource_arns: List[str], region: str) -> List[Dict[str, Any]]:
  """Fetch details for VPCs given their ARNs."""
  if not resource_arns:
    return []

  ec2_client = session.client("ec2", region_name=region)
  vpc_id_arn_map = {arn.split("/")[-1]: arn for arn in resource_arns}
  vpc_ids = list(vpc_id_arn_map.keys())

  try:
    response = (await asyncio.to_thread(ec2_client.describe_vpcs, VpcIds=vpc_ids))
    vpcs = []
    for vpc in response["Vpcs"]:
      vpc["Arn"] = vpc_id_arn_map[vpc["VpcId"]]
      vpcs.append(vpc)
    return vpcs
  except Exception as e:
    logging.error(f"Error fetching VPC details: {e}")
    return []


async def get_subnet_details(session: boto3.Session, resource_arns: List[str], region: str) -> List[Dict[str, Any]]:
  """Fetch details for Subnets given their ARNs."""
  if not resource_arns:
    return []

  ec2_client = session.client("ec2", region_name=region)
  subnet_id_arn_map = {arn.split("/")[-1]: arn for arn in resource_arns}
  subnet_ids = list(subnet_id_arn_map.keys())

  try:
    response = (await asyncio.to_thread(ec2_client.describe_subnets, SubnetIds=subnet_ids))
    subnets = []
    for subnet in response["Subnets"]:
      subnet["Arn"] = subnet_id_arn_map[subnet["SubnetId"]]
      subnets.append(subnet)
    return subnets
  except Exception as e:
    logging.error(f"Error fetching Subnet details: {e}")
    return []


async def get_security_group_details(session: boto3.Session, resource_arns: List[str], region: str) -> List[Dict[str, Any]]:
  """Fetch details for Security Groups given their ARNs."""
  if not resource_arns:
    return []

  ec2_client = session.client("ec2", region_name=region)
  sg_id_arn_map = {arn.split("/")[-1]: arn for arn in resource_arns}
  sg_ids = list(sg_id_arn_map.keys())

  try:
    response = (await asyncio.to_thread(ec2_client.describe_security_groups, GroupIds=sg_ids))
    security_groups = []
    for sg in response["SecurityGroups"]:
      sg["Arn"] = sg_id_arn_map[sg["GroupId"]]
      security_groups.append(sg)
    return security_groups
  except Exception as e:
    logging.error(f"Error fetching Security Group details: {e}")
    return []


async def get_rds_details(session: boto3.Session, resource_arns: List[str], region: str) -> List[Dict[str, Any]]:
  """Fetch details for RDS Database Instances given their ARNs."""
  if not resource_arns:
    return []

  rds_client = session.client("rds", region_name=region)
  db_instance_ids = [arn.split(":")[-1] for arn in resource_arns]

  try:
    response = (await asyncio.to_thread(rds_client.describe_db_instances))
    db_instances = []
    for db in response["DBInstances"]:
      if db["DBInstanceIdentifier"] in db_instance_ids:
        db_instances.append(db)
    return db_instances
  except Exception as e:
    logging.error(f"Error fetching RDS instance details: {e}")
    return []


async def get_lambda_details(session: boto3.Session, resource_arns: List[str], region: str) -> List[Dict[str, Any]]:
  """Fetch details for Lambda functions given their ARNs."""
  if not resource_arns:
    return []

  lambda_client = session.client("lambda", region_name=region)
  function_names = [arn.split(":")[-1] for arn in resource_arns]

  functions = []
  for function_name in function_names:
    logging.debug(f"Fetching details for Lambda function: {function_name}")
    try:
      response = (await asyncio.to_thread(lambda_client.get_function, FunctionName=function_name))
      function_config = response.get("Configuration", {})
      if function_config:
        functions.append(function_config)
    except Exception as e:
      logging.error(f"Error fetching Lambda function {function_name}: {e}")

  return functions


async def get_dynamodb_details(session: boto3.Session, resource_arns: List[str], region: str) -> List[Dict[str, Any]]:
  """Fetch details for DynamoDB tables given their ARNs."""
  if not resource_arns:
    return []

  dynamodb_client = session.client("dynamodb", region_name=region)
  table_names = [arn.split("/")[-1] for arn in resource_arns]

  tables = []
  for table_name in table_names:
    logging.debug(f"Fetching details for DynamoDB table: {table_name}")
    try:
      response = (await asyncio.to_thread(dynamodb_client.describe_table, TableName=table_name))
      table = response.get("Table", {})
      if table:
        tables.append(table)
    except Exception as e:
      logging.error(f"Error fetching DynamoDB table {table_name}: {e}")

  return tables


# ============================================================================
# Entity Conversion
# ============================================================================


def resource_type_to_entity_type(resource_type: str) -> str:
  """
  Convert AWS resource type to Neo4j-friendly entity type in Pascal case.

  Examples:
      iam:user -> AwsIamUser
      ec2:instance -> AwsEc2Instance
      ec2:security-group -> AwsEc2SecurityGroup
      elasticloadbalancing:loadbalancer -> AwsElasticloadbalancingLoadbalancer
  """
  # Split by colons and hyphens, capitalize each part, then join
  parts = resource_type.replace(":", "-").split("-")
  pascal_parts = [part.capitalize() for part in parts]
  return "Aws" + "".join(pascal_parts)


# ============================================================================
# Sync Logic
# ============================================================================


async def ensure_account_entity_exists(client: Client, account_id: str, datasource_id: str, job_id: str) -> None:
  """
  Ensure the AWS account entity exists in the graph database.
  The graph database will handle deduplication if the entity already exists.

  Args:
      client: RAG client instance
      account_id: AWS account ID
      datasource_id: Datasource ID
      job_id: Current job ID for error tracking
  """
  try:
    logging.info(f"Ingesting AwsAccount entity for account: {account_id}")

    account_entity = StructuredEntity(entity_type="AwsAccount", primary_key_properties=["account_id"], all_properties={"account_id": account_id})

    await client.ingest_entities(job_id=job_id, datasource_id=datasource_id, entities=[account_entity], fresh_until=utils.get_fresh_until(SYNC_INTERVAL))
    logging.info(f"Ingested AwsAccount entity: {account_id}")

  except Exception as e:
    logging.warning(f"Could not ingest account entity: {e}")
    # Non-fatal error - continue with resource ingestion


async def sync_resource_type(client: Client, session: boto3.Session, account_id: str, resource_type: str, region: str, job_id: str, datasource_id: str) -> int:
  """
  Sync a specific resource type in a specific region.

  Args:
      client: RAG client instance
      session: boto3 session for the target account
      account_id: AWS account ID
      resource_type: AWS resource type string (e.g. 'ec2:instance')
      region: AWS region name
      job_id: Current job ID
      datasource_id: Datasource ID

  Returns:
      int: Number of entities successfully ingested
  """
  config = RESOURCE_CONFIG.get(resource_type)
  if not config:
    logging.warning(f"No configuration found for resource type '{resource_type}'")
    return 0

  try:
    # Fetch resource ARNs
    if config["fetch_fn"] in ["list_iam_users", "get_rds_details", "get_lambda_details", "get_dynamodb_details"]:
      # Some services don't need ARN fetching via tagging API
      resource_arns = []
    else:
      resource_arns = await fetch_resources(session, resource_type, region)

    if not resource_arns and config["fetch_fn"] not in ["list_iam_users", "get_rds_details", "get_lambda_details", "get_dynamodb_details"]:
      logging.debug(f"No {resource_type} resources found in region {region}")
      return 0

    # Fetch resource details using the configured function
    fetch_fn_name = config["fetch_fn"]
    fetch_fn = globals()[fetch_fn_name]

    if fetch_fn_name == "list_iam_users":
      # list_iam_users handles its own resource discovery, only needs session
      inventory = await fetch_fn(session)
    elif fetch_fn_name in ["get_rds_details", "get_lambda_details", "get_dynamodb_details"]:
      # These functions handle their own resource discovery
      inventory = await fetch_fn(session, resource_arns, region)
    else:
      inventory = await fetch_fn(session, resource_arns, region)

    if not inventory:
      logging.debug(f"No details fetched for {resource_type} in region {region}")
      return 0

    logging.info(f"Fetched {len(inventory)} {resource_type} resources in region {region}")

    # Convert to entities
    entities = []
    for resource in inventory:
      # Copy resource properties and add metadata
      props = resource.copy()
      props["account_id"] = account_id
      props["region"] = region

      # Verify additional key properties exist
      additional_key_properties_verified = []
      for additional_key_property in config["additional_keys"]:
        if all(key in props for key in additional_key_property):
          additional_key_properties_verified.append(additional_key_property)

      entity = StructuredEntity(entity_type=resource_type_to_entity_type(resource_type), primary_key_properties=config["primary_key"], additional_key_properties=additional_key_properties_verified, all_properties=props)
      entities.append(entity)

    # Ingest entities
    if entities:
      await client.ingest_entities(job_id=job_id, datasource_id=datasource_id, entities=entities, fresh_until=utils.get_fresh_until(SYNC_INTERVAL))
      await client.increment_job_progress(job_id, len(entities))
      logging.info(f"Ingested {len(entities)} {resource_type} entities from region {region}")

    return len(entities)

  except Exception as e:
    error_msg = f"Error syncing {resource_type} in region {region}: {str(e)}"
    logging.error(error_msg, exc_info=True)
    await client.add_job_error(job_id, [error_msg])
    await client.increment_job_failure(job_id, 1)
    return 0


async def sync_account(client: Client, session: boto3.Session, account_name: str) -> None:
  """
  Sync all resources for a single AWS account.

  Creates a datasource for the account, discovers all regions, and syncs
  all configured resource types.

  Args:
      client: RAG client instance
      session: boto3 session configured for the target account
      account_name: Human-readable account name (for logging and metadata)
  """
  # Get AWS account ID
  account_id = await get_account_id(session)
  logging.info(f"Syncing account: {account_name} (ID: {account_id})")

  if not account_id:
    raise ValueError(f"Failed to retrieve AWS account ID for account '{account_name}'. Check AWS credentials.")

  # Create datasource
  datasource_id = f"aws-account-{account_id}"
  datasource_info = DataSourceInfo(
    datasource_id=datasource_id,
    name=f"AWS: {account_name} ({account_id})",
    ingestor_id=client.ingestor_id or "",
    description=f"AWS resources for account {account_name} ({account_id})",
    source_type="aws",
    last_updated=int(time.time()),
    default_chunk_size=0,  # Skip chunking for graph entities
    default_chunk_overlap=0,
    reload_interval=SYNC_INTERVAL,
    metadata={
      "account_id": account_id,
      "account_name": account_name,
      "resource_types": RESOURCE_TYPES,
    },
  )
  async def sync_datasource() -> None:
    await client.upsert_datasource(datasource_info)
    logging.info(f"Created/updated datasource: {datasource_id}")

    # Get all AWS regions
    regions = await get_all_regions(session)
    logging.info(f"Found {len(regions)} AWS regions for account {account_name}")

    # Calculate total work for job tracking
    regional_resource_types = [rt for rt in RESOURCE_TYPES if RESOURCE_CONFIG.get(rt, {}).get("regional", True)]
    global_resource_types = [rt for rt in RESOURCE_TYPES if not RESOURCE_CONFIG.get(rt, {}).get("regional", True)]
    total_work_items = len(regional_resource_types) * len(regions) + len(global_resource_types)

    # Create job
    job_response = await client.create_job(datasource_id=datasource_id, job_status=JobStatus.IN_PROGRESS, message=f"Syncing AWS resources for account {account_name} across {len(regions)} regions", total=total_work_items)
    job_id = job_response["job_id"]
    logging.info(f"Created job {job_id} with {total_work_items} work items for account {account_name}")

    try:
      # Ensure account entity exists
      await ensure_account_entity_exists(client, account_id, datasource_id, job_id)

      total_entities = 0

      # Process global resources (IAM, Route53)
      for resource_type in global_resource_types:
        logging.info(f"[{account_name}] Processing global resource type: {resource_type}")
        count = await sync_resource_type(client, session, account_id, resource_type, "us-east-1", job_id, datasource_id)
        total_entities += count

      # Process regional resources
      for resource_type in regional_resource_types:
        logging.info(f"[{account_name}] Processing regional resource type: {resource_type}")
        for region in regions:
          count = await sync_resource_type(client, session, account_id, resource_type, region, job_id, datasource_id)
          total_entities += count

      # Mark job as completed
      await client.update_job(job_id=job_id, job_status=JobStatus.COMPLETED, message=f"Successfully synced {total_entities} AWS resources for account {account_name}")
      logging.info(f"Sync completed for account {account_name}. Total entities ingested: {total_entities}")

    except Exception as e:
      error_msg = f"AWS resource sync failed for account {account_name}: {str(e)}"
      await client.add_job_error(job_id, [error_msg])
      await client.update_job(job_id=job_id, job_status=JobStatus.FAILED, message=error_msg)
      logging.error(error_msg, exc_info=True)
      raise

  await run_standalone_ingestion(datasource_info.datasource_id, sync_datasource)


async def sync_aws_resources(client: Client) -> None:
  """
  Main sync function that orchestrates AWS resource ingestion.
  This function is called periodically by the IngestorBuilder.

  In multi-account mode (AWS_ACCOUNT_LIST is set), iterates over all configured
  accounts sequentially. Each account becomes a separate datasource.

  In single-account mode (AWS_ACCOUNT_LIST not set), uses default credentials
  to sync a single account (backward compatible).
  """
  logging.info("Starting AWS resource sync...")

  accounts = parse_account_list()

  if not accounts:
    # Single-account mode: use default credentials (backward compatible)
    logging.info("Single-account mode: using default AWS credentials")
    session = create_session()
    await sync_account(client, session, "default")
  else:
    # Multi-account mode: iterate over configured accounts
    logging.info(f"Multi-account mode: syncing {len(accounts)} accounts")
    setup_aws_profiles(accounts)

    succeeded = 0
    failed = 0
    for account in accounts:
      try:
        session = create_session(profile_name=account["name"])
        await sync_account(client, session, account["name"])
        succeeded += 1
      except Exception as e:
        logging.error(f"Failed to sync account {account['name']} ({account['id']}): {e}", exc_info=True)
        failed += 1
        # Continue with next account -- don't let one failure stop the rest

    logging.info(f"Multi-account sync complete: {succeeded} succeeded, {failed} failed out of {len(accounts)} accounts")

    if failed == len(accounts):
      raise RuntimeError(f"All {failed} account syncs failed")


if __name__ == "__main__":
  try:
    logging.info("Starting AWS ingestor using IngestorBuilder...")

    accounts = parse_account_list()

    if accounts:
      # Multi-account mode
      setup_aws_profiles(accounts)
      ingestor_name = "aws_ingestor_multi"
      account_names = ", ".join(a["name"] for a in accounts)
      ingestor_description = f"AWS ingestor for {len(accounts)} accounts: {account_names}"
      ingestor_metadata = {
        "accounts": [a["name"] for a in accounts],
        "resource_types": RESOURCE_TYPES,
        "sync_interval": SYNC_INTERVAL,
      }
      logging.info(f"Multi-account mode: {len(accounts)} accounts configured ({account_names})")
    else:
      # Single-account mode (backward compatible)
      session = create_session()
      account_id = asyncio.run(get_account_id(session))
      ingestor_name = f"aws_ingestor_{account_id}"
      ingestor_description = "Ingestor for AWS resources (EC2, S3, EKS, IAM, etc.)"
      ingestor_metadata = {
        "resource_types": RESOURCE_TYPES,
        "sync_interval": SYNC_INTERVAL,
      }
      logging.info(f"Single-account mode: account {account_id}")

    # Use IngestorBuilder for simplified ingestor creation
    IngestorBuilder().name(ingestor_name).type("aws").description(ingestor_description).metadata(ingestor_metadata).sync_with_fn(sync_aws_resources).every(SYNC_INTERVAL).with_init_delay(int(os.getenv("INIT_DELAY_SECONDS", "0"))).run()

  except KeyboardInterrupt:
    logging.info("AWS ingestor execution interrupted by user")
  except Exception as e:
    logging.error(f"AWS ingestor failed: {e}", exc_info=True)
