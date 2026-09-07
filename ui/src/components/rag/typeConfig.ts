/**
 * Type Configuration - Ported from RAG WebUI
 *
 * Centralized configuration for entity/datasource types
 * This includes color schemes and icon mappings
 */

import type { IngestionSourceType } from "@/types/ingestion-source";

// Color map for entity types
export const colorMap: { [key: string]: string } = {
  aws: "#FFC107",
  backstage: "#4CAF50",
  k8s: "#2196F3",
  kubernetes: "#2196F3",
  argo: "#ef7b4d",
  github: "#3f3f3f",
  slack: "#4A154B",
  webex: "#07C1E4",
  jira: "#0052CC",
};

// Icon map for ingestor/datasource types
// Uses SVG icons from /public folder (except 'web' which uses emoji)
export const iconMap: { [key: string]: string } = {
  aws: "/aws.svg",
  backstage: "/backstage.svg",
  k8s: "/kubernetes.svg",
  kubernetes: "/kubernetes.svg",
  argo: "/argocd.svg",
  slack: "/slack.svg",
  webex: "/webex.svg",
  jira: "/jira.svg",
  komodor: "/komodor.svg",
  pagerduty: "/pagerduty.svg",
  splunk: "/splunk.svg",
  web: "🌐", // Web uses emoji
  confluence: "/confluence.svg",
};

export const defaultColor = "#9E9E9E";

// Mapping between ingest UI types and required ingestor types
// This defines which ingestor types are needed for each UI option to be enabled
export interface IngestTypeConfig {
  label: string; // Display label for the UI button
  requiredIngestorType: string; // Required ingestor type to enable this option
  icon?: string; // Optional icon override
  sourceType?: IngestionSourceType; // Managed source type opened by this option
}

export const ingestTypeConfigs: Record<string, IngestTypeConfig> = {
  file: {
    label: "File",
    requiredIngestorType: "local-file",
    icon: "📄",
  },
  web: {
    label: "Web",
    requiredIngestorType: "webloader",
    icon: "🌐",
    sourceType: "web_url",
  },
  slack: {
    label: "Slack",
    requiredIngestorType: "slack",
    icon: "/slack.svg",
    sourceType: "slack_channel",
  },
  confluence: {
    label: "Confluence",
    requiredIngestorType: "confluence",
    icon: "/confluence.svg",
    sourceType: "confluence_space",
  },
  jira: {
    label: "Jira",
    requiredIngestorType: "jira",
    icon: "/jira.svg",
    sourceType: "jira_project",
  },
  webex: {
    label: "Webex",
    requiredIngestorType: "webex",
    icon: "/webex.svg",
    sourceType: "webex_space",
  },
};

export const INGESTOR_HEARTBEAT_MAX_AGE_SECONDS = 300;

export const isIngestorOnline = (
  ingestor: { last_seen?: number },
  nowSeconds = Math.floor(Date.now() / 1000),
): boolean =>
  typeof ingestor.last_seen === "number" &&
  ingestor.last_seen >= nowSeconds - INGESTOR_HEARTBEAT_MAX_AGE_SECONDS;

const SCHEDULED_RELOAD_SOURCE_TYPES = new Set([
  "web",
  "confluence",
  "slack",
  "jira",
  "webex",
]);

export const supportsScheduledReload = (sourceType: string): boolean =>
  SCHEDULED_RELOAD_SOURCE_TYPES.has(sourceType.toLowerCase());

// File datasources have no external source to periodically refresh from, but
// they do support replacing their content in place via a manual re-upload.
const REUPLOAD_SOURCE_TYPES = new Set(["local_file"]);

export const supportsReupload = (sourceType: string): boolean =>
  REUPLOAD_SOURCE_TYPES.has(sourceType.toLowerCase());

// Helper function to check if an ingest type is available based on ingestors
export const isIngestTypeAvailable = (
  ingestType: string,
  availableIngestors: { ingestor_type: string; last_seen?: number }[],
  nowSeconds = Math.floor(Date.now() / 1000),
): boolean => {
  const config = ingestTypeConfigs[ingestType];
  if (!config) return false;
  if (ingestType === "file") return true;

  return availableIngestors.some(
    (ingestor) =>
      ingestor.ingestor_type === config.requiredIngestorType &&
      isIngestorOnline(ingestor, nowSeconds),
  );
};

// Helper function to get all available ingest types based on ingestors
export const getAvailableIngestTypes = (
  availableIngestors: { ingestor_type: string; last_seen?: number }[],
): string[] => {
  return Object.keys(ingestTypeConfigs).filter((ingestType) =>
    isIngestTypeAvailable(ingestType, availableIngestors),
  );
};

// Helper function to get icon for a given type/label
export const getIconForType = (label: string): string | null => {
  const lowerLabel = label.toLowerCase();
  const ingestType =
    lowerLabel === "local_file" || lowerLabel === "local-file"
      ? "file"
      : lowerLabel;
  const configuredIcon = ingestTypeConfigs[ingestType]?.icon;
  if (configuredIcon) return configuredIcon;

  for (const prefix in iconMap) {
    if (lowerLabel.startsWith(prefix.toLowerCase())) {
      return iconMap[prefix];
    }
  }
  return null;
};

// Helper function to get color for a given type/label
export const getColorForType = (label: string): string => {
  const lowerLabel = label.toLowerCase();
  for (const prefix in colorMap) {
    if (lowerLabel.startsWith(prefix.toLowerCase())) {
      return colorMap[prefix];
    }
  }
  return defaultColor;
};
