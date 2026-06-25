#!/usr/bin/env python3
"""
 MCP Server

This server provides a Model Context Protocol (MCP) interface to the ,
allowing large language models and AI assistants to interact with the service.
"""

import logging
import os
from dotenv import load_dotenv
from fastmcp import FastMCP


from tools import usage_reports

from tools import models

from tools import models_model_id

from tools import utils_supported_openai_params

from tools import model_info

from tools import model_group_info

from tools import routes

from tools import public_providers

from tools import public_providers_fields

from tools import public_litellm_model_cost_map

from tools import public_endpoints

from tools import credentials

from tools import credentials_by_name_credential_name

from tools import credentials_by_model_model_id

from tools import config_pass_through_endpoint_team_team_id

from tools import config_pass_through_endpoint

from tools import health_services

from tools import health

from tools import health_history

from tools import health_latest

from tools import health_shared_status

from tools import health_license

from tools import active_callbacks

from tools import settings

from tools import health_readiness

from tools import health_backlog

from tools import health_liveness

from tools import key_info

from tools import key_list

from tools import key_aliases

from tools import user_info

from tools import user_list

from tools import user_daily_activity

from tools import user_daily_activity_aggregated

from tools import team_info

from tools import team_available

from tools import team_list

from tools import team_permissions_list

from tools import team_daily_activity

from tools import organization_daily_activity

from tools import organization_list

from tools import organization_info

from tools import project_info

from tools import project_list

from tools import customer_info

from tools import customer_list

from tools import customer_daily_activity

from tools import spend_tags

from tools import global_spend_report

from tools import global_spend_tags

from tools import spend_logs_v2

from tools import spend_logs

from tools import provider_budgets

from tools import cloudzero_settings

from tools import vantage_settings

from tools import cache_ping

from tools import cache_redis_info

from tools import guardrails_list

from tools import guardrails_submissions

from tools import guardrails_submissions_guardrail_id

from tools import guardrails_guardrail_id_info

from tools import guardrails_usage_overview

from tools import policies_usage_overview

from tools import policy_info_policy_name

from tools import policies_list

from tools import policies_name_policy_name_versions

from tools import policies_compare

from tools import policies_policy_id

from tools import policies_policy_id_resolved_guardrails

from tools import search_tools_list

from tools import search_tools_search_tool_id

from tools import search_tools_ui_available_providers

from tools import prompts_list

from tools import prompts_prompt_id_versions

from tools import prompts_prompt_id_info

from tools import callbacks_list

from tools import callbacks_configs

from tools import debug_asyncio_tasks

from tools import get_internal_user_settings

from tools import get_default_team_settings

from tools import get_sso_settings

from tools import get_ui_theme_settings

from tools import get_mcp_semantic_filter_settings

from tools import in_product_nudges

from tools import get_ui_settings

from tools import team_team_id_callback

from tools import jwt_key_mapping_list

from tools import jwt_key_mapping_info

from tools import budget_settings

from tools import budget_list

from tools import access_group_list

from tools import access_group_access_group_info

from tools import tag_list

from tools import tag_daily_activity

from tools import config_cost_discount_config

from tools import config_cost_margin_config

from tools import router_settings

from tools import router_fields

from tools import fallback_model

from tools import cache_settings

from tools import config_overrides_hashicorp_vault

from tools import tag_distinct

from tools import tag_dau

from tools import tag_wau

from tools import tag_mau

from tools import tag_summary

from tools import tag_user_agent_per_user_analytics

from tools import email_event_settings

from tools import audit

from tools import audit_id

from tools import user_available_users

from mcp_litellm.tools import token_usage_alerts
import token_alert_scanner


def main():
  # Load environment variables
  load_dotenv()

  # Configure logging
  logging.basicConfig(level=logging.INFO)

  # Get MCP configuration from environment variables
  MCP_MODE = os.getenv("MCP_MODE", "stdio").lower()

  # Get host and port for server
  MCP_HOST = os.getenv("MCP_HOST", "localhost")
  MCP_PORT = int(os.getenv("MCP_PORT", "8000"))

  logging.info(f"Starting MCP server in {MCP_MODE} mode on {MCP_HOST}:{MCP_PORT}")

  # Get agent name from environment variables
  SERVER_NAME = os.getenv("SERVER_NAME") or os.getenv("AGENT_NAME") or "LITELLM"
  logging.info(f"MCP Server name: {SERVER_NAME}")

  # Create server instance
  mcp = FastMCP(f"{SERVER_NAME} MCP Server")

  # Register curated report tools first so agents prefer summarized analytics
  # over raw paginated spend logs for FinOps questions.

  mcp.tool()(usage_reports.get_llm_token_usage_report)
  mcp.tool()(usage_reports.get_llm_spend_by_model_report)
  mcp.tool()(usage_reports.get_llm_usage_and_spend_by_user_report)
  mcp.tool()(usage_reports.get_llm_top_models_report)
  mcp.tool()(usage_reports.get_llm_usage_by_user_report)

  # Register models tools

  mcp.tool()(models.get_model_ls_models_get)

  # Register models_model_id tools

  mcp.tool()(models_model_id.get_model_info_models_model_id_get)

  # Register utils_supported_openai_params tools

  mcp.tool()(utils_supported_openai_params.get_supported_openai_get)

  # Register model_info tools

  mcp.tool()(model_info.get_model_info_v1_model_info_get)

  # Register model_group_info tools

  mcp.tool()(model_group_info.get_model_group_get)

  # Register routes tools

  mcp.tool()(routes.get_routes_routes_get)

  # Register public_providers tools

  mcp.tool()(public_providers.get_supported_get)

  # Register public_providers_fields tools

  mcp.tool()(public_providers_fields.get_provider_get)

  # Register public_litellm_model_cost_map tools

  mcp.tool()(public_litellm_model_cost_map.get_litellm_get)

  # Register public_endpoints tools

  mcp.tool()(public_endpoints.get_get_supported_get)

  # Register credentials tools

  mcp.tool()(credentials.get_credentials_get)

  # Register credentials_by_name_credential_name tools

  mcp.tool()(credentials_by_name_credential_name.get_credential_get)

  # Register credentials_by_model_model_id tools

  mcp.tool()(credentials_by_model_model_id.get_get_credential_get)

  # Register config_pass_through_endpoint_team_team_id tools

  mcp.tool()(config_pass_through_endpoint_team_team_id.get_pass_get)

  # Register config_pass_through_endpoint tools

  mcp.tool()(config_pass_through_endpoint.get_get_pass_get)

  # Register health_services tools

  mcp.tool()(health_services.get_health_svcs_get)

  # Register health tools

  mcp.tool()(health.get_health_endpoint_health_get)

  # Register health_history tools

  mcp.tool()(health_history.get_health_check_get)

  # Register health_latest tools

  mcp.tool()(health_latest.get_latest_health_get)

  # Register health_shared_status tools

  mcp.tool()(health_shared_status.get_shared_health_get)

  # Register health_license tools

  mcp.tool()(health_license.get_health_license_get)

  # Register active_callbacks tools

  mcp.tool()(active_callbacks.get_active_callbacks_get)

  # Register settings tools

  mcp.tool()(settings.get_active_callbacks_settings_get)

  # Register health_readiness tools

  mcp.tool()(health_readiness.get_health_readiness_get)

  # Register health_backlog tools

  mcp.tool()(health_backlog.get_health_backlog_get)

  # Register health_liveness tools

  mcp.tool()(health_liveness.get_health_liveliness_get)

  # Register key_info tools

  mcp.tool()(key_info.get_info_key_fn_key_info_get)

  # Register key_list tools

  mcp.tool()(key_list.get_ls_keys_key_ls_get)

  # Register key_aliases tools

  mcp.tool()(key_aliases.get_key_aliases_key_aliases_get)

  # Register user_info tools

  mcp.tool()(user_info.get_user_info_user_info_get)

  # Register user_list tools

  mcp.tool()(user_list.get_users_user_ls_get)

  # Register user_daily_activity tools

  mcp.tool()(user_daily_activity.get_user_get)

  # Register user_daily_activity_aggregated tools

  mcp.tool()(user_daily_activity_aggregated.get_get_user_get)

  # Register team_info tools

  mcp.tool()(team_info.get_team_info_team_info_get)

  # Register team_available tools

  mcp.tool()(team_available.get_ls_available_get)

  # Register team_list tools

  mcp.tool()(team_list.get_ls_team_team_ls_get)

  # Register team_permissions_list tools

  mcp.tool()(team_permissions_list.get_team_member_get)

  # Register team_daily_activity tools

  mcp.tool()(team_daily_activity.get_team_get)

  # Register organization_daily_activity tools

  mcp.tool()(organization_daily_activity.get_organization_get)

  # Register organization_list tools

  mcp.tool()(organization_list.get_ls_organization_get)

  # Register organization_info tools

  mcp.tool()(organization_info.get_info_organization_get)

  # Register project_info tools

  mcp.tool()(project_info.get_project_info_project_info_get)

  # Register project_list tools

  mcp.tool()(project_list.get_ls_projects_project_ls_get)

  # Register customer_info tools

  mcp.tool()(customer_info.get_end_user_get)

  # Register customer_list tools

  mcp.tool()(customer_list.get_ls_end_user_customer_ls_get)

  # Register customer_daily_activity tools

  mcp.tool()(customer_daily_activity.get_customer_get)

  # Register spend_tags tools

  mcp.tool()(spend_tags.get_view_spend_tags_spend_tags_get)

  # Register global_spend_report tools

  mcp.tool()(global_spend_report.get_global_get)

  # Register global_spend_tags tools

  mcp.tool()(global_spend_tags.get_global_view_get)

  # Register spend_logs_v2 tools

  mcp.tool()(spend_logs_v2.get_ui_view_get)

  # Register spend_logs tools

  mcp.tool()(spend_logs.get_view_spend_logs_spend_logs_get)

  # Register provider_budgets tools

  mcp.tool()(provider_budgets.get_provider_budgets_get)

  # Register cloudzero_settings tools

  mcp.tool()(cloudzero_settings.get_cloudzero_get)

  # Register vantage_settings tools

  mcp.tool()(vantage_settings.get_vantage_get)

  # Register cache_ping tools

  mcp.tool()(cache_ping.get_cache_ping_cache_ping_get)

  # Register cache_redis_info tools

  mcp.tool()(cache_redis_info.get_cache_redis_get)

  # Register guardrails_list tools

  mcp.tool()(guardrails_list.get_ls_guardrails_get)

  # Register guardrails_submissions tools

  mcp.tool()(guardrails_submissions.get_ls_guardrail_get)

  # Register guardrails_submissions_guardrail_id tools

  mcp.tool()(guardrails_submissions_guardrail_id.get_guardrail_get)

  # Register guardrails_guardrail_id_info tools

  mcp.tool()(guardrails_guardrail_id_info.get_get_guardrail_get)

  # Register guardrails_usage_overview tools

  mcp.tool()(guardrails_usage_overview.get_guardrails_usage_get)

  # Register policies_usage_overview tools

  mcp.tool()(policies_usage_overview.get_policies_usage_get)

  # Register policy_info_policy_name tools

  mcp.tool()(policy_info_policy_name.get_policy_get)

  # Register policies_list tools

  mcp.tool()(policies_list.get_ls_policies_policies_ls_get)

  # Register policies_name_policy_name_versions tools

  mcp.tool()(policies_name_policy_name_versions.get_ls_policy_get)

  # Register policies_compare tools

  mcp.tool()(policies_compare.get_compare_policy_get)

  # Register policies_policy_id tools

  mcp.tool()(policies_policy_id.get_get_policy_get)

  # Register policies_policy_id_resolved_guardrails tools

  mcp.tool()(policies_policy_id_resolved_guardrails.get_resolved_get)

  # Register search_tools_list tools

  mcp.tool()(search_tools_list.get_ls_search_get)

  # Register search_tools_search_tool_id tools

  mcp.tool()(search_tools_search_tool_id.get_search_get)

  # Register search_tools_ui_available_providers tools

  mcp.tool()(search_tools_ui_available_providers.get_available_get)

  # Register prompts_list tools

  mcp.tool()(prompts_list.get_ls_prompts_prompts_ls_get)

  # Register prompts_prompt_id_versions tools

  mcp.tool()(prompts_prompt_id_versions.get_prompt_get)

  # Register prompts_prompt_id_info tools

  mcp.tool()(prompts_prompt_id_info.get_get_prompt_get)

  # Register callbacks_list tools

  mcp.tool()(callbacks_list.get_ls_callbacks_callbacks_ls_get)

  # Register callbacks_configs tools

  mcp.tool()(callbacks_configs.get_callback_get)

  # Register debug_asyncio_tasks tools

  mcp.tool()(debug_asyncio_tasks.get_active_get)

  # Register get_internal_user_settings tools

  mcp.tool()(get_internal_user_settings.get_internal_get)

  # Register get_default_team_settings tools

  mcp.tool()(get_default_team_settings.get_default_get)

  # Register get_sso_settings tools

  mcp.tool()(get_sso_settings.get_sso_get)

  # Register get_ui_theme_settings tools

  mcp.tool()(get_ui_theme_settings.get_ui_get)

  # Register get_mcp_semantic_filter_settings tools

  mcp.tool()(get_mcp_semantic_filter_settings.get_mcp_get)

  # Register in_product_nudges tools

  mcp.tool()(in_product_nudges.get_in_get)

  # Register get_ui_settings tools

  mcp.tool()(get_ui_settings.get_get_ui_get)

  # Register team_team_id_callback tools

  mcp.tool()(team_team_id_callback.get_get_team_get)

  # Register jwt_key_mapping_list tools

  mcp.tool()(jwt_key_mapping_list.get_ls_jwt_get)

  # Register jwt_key_mapping_info tools

  mcp.tool()(jwt_key_mapping_info.get_info_jwt_get)

  # Register budget_settings tools

  mcp.tool()(budget_settings.get_budget_settings_get)

  # Register budget_list tools

  mcp.tool()(budget_list.get_ls_budget_budget_ls_get)

  # Register access_group_list tools

  mcp.tool()(access_group_list.get_ls_access_get)

  # Register access_group_access_group_info tools

  mcp.tool()(access_group_access_group_info.get_access_get)

  # Register tag_list tools

  mcp.tool()(tag_list.get_ls_tags_tag_ls_get)

  # Register tag_daily_activity tools

  mcp.tool()(tag_daily_activity.get_tag_get)

  # Register config_cost_discount_config tools

  mcp.tool()(config_cost_discount_config.get_cost_get)

  # Register config_cost_margin_config tools

  mcp.tool()(config_cost_margin_config.get_get_cost_get)

  # Register router_settings tools

  mcp.tool()(router_settings.get_router_get)

  # Register router_fields tools

  mcp.tool()(router_fields.get_get_router_get)

  # Register fallback_model tools

  mcp.tool()(fallback_model.get_fallback_get)

  # Register cache_settings tools

  mcp.tool()(cache_settings.get_cache_get)

  # Register config_overrides_hashicorp_vault tools

  mcp.tool()(config_overrides_hashicorp_vault.get_hashicorp_get)

  # Register tag_distinct tools

  mcp.tool()(tag_distinct.get_distinct_get)

  # Register tag_dau tools

  mcp.tool()(tag_dau.get_daily_get)

  # Register tag_wau tools

  mcp.tool()(tag_wau.get_weekly_get)

  # Register tag_mau tools

  mcp.tool()(tag_mau.get_monthly_get)

  # Register tag_summary tools

  mcp.tool()(tag_summary.get_get_tag_get)

  # Register tag_user_agent_per_user_analytics tools

  mcp.tool()(tag_user_agent_per_user_analytics.get_per_get)

  # Register email_event_settings tools

  mcp.tool()(email_event_settings.get_email_get)

  # Register audit tools

  mcp.tool()(audit.get_audit_logs_audit_get)

  # Register audit_id tools

  mcp.tool()(audit_id.get_audit_log_id_audit_id_get)

  # Register user_available_users tools

  mcp.tool()(user_available_users.get_available_enterprise_get)

  # Register token_usage_alerts tools

  mcp.tool()(token_usage_alerts.evaluate_token_usage_alert)
  mcp.tool()(token_alert_scanner.scan_token_usage_alerts)

  # Run the MCP server
  if MCP_MODE.lower() in ["sse", "http"]:
    mcp.run(transport=MCP_MODE.lower(), host=MCP_HOST, port=MCP_PORT)
  else:
    mcp.run(transport=MCP_MODE.lower())


if __name__ == "__main__":
  main()
