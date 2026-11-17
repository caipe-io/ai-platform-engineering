export const FEEDBACK_SEVERITIES = ["Blocks my work", "Annoying", "Minor"] as const;
export type FeedbackSeverity = (typeof FEEDBACK_SEVERITIES)[number];

export const SERVICE_DESK_AREAS = [
  "Compute", "ArgoCD", "Vault", "GitHub", "Directory groups", "Logging", "Kubernetes", "Platform", "SSO / IAM",
  "CI / GitHub Actions", "Infrastructure as code", "Artifacts / Registries", "Data Services", "AI / ML",
  "Networking / DNS / Certificates", "Sandboxes", "Applications", "Other",
] as const;
export const SERVICE_DESK_SEVERITIES = ["Urgent", "High", "Medium", "Low"] as const;
export const SERVICE_DESK_TYPES = ["Bug", "Enhancement", "Ticket"] as const;

export interface ServiceDeskDetailField { label: string; options?: readonly string[] }
const ENVIRONMENTS = ["dev", "staging", "prod"] as const;
/** Optional extra questions per area. They are added to the description, not to the classification. */
export const SERVICE_DESK_DETAILS: Record<string, readonly ServiceDeskDetailField[]> = {
  "AI / ML": [{ label: "Current monthly limit ($)" }, { label: "Requested monthly limit ($)" }, { label: "Key type", options: ["Individual", "Team"] }],
  "GitHub": [{ label: "Org or repo" }, { label: "What changes", options: ["Add to team", "Single sign-on access", "Package access", "Pages"] }, { label: "Team name" }],
  "CI / GitHub Actions": [{ label: "Repo" }, { label: "What changes", options: ["Allow an action", "Workflow is failing"] }],
  "Compute": [{ label: "Account or role" }, { label: "Resource" }, { label: "Access level", options: ["Read", "Read and write", "Admin"] }, { label: "Environment", options: ENVIRONMENTS }],
  "Vault": [{ label: "Namespace path" }, { label: "Role", options: ["Reader", "Writer", "Admin"] }, { label: "Environment", options: ENVIRONMENTS }],
  "Data Services": [{ label: "Kind", options: ["PostgreSQL", "Managed PostgreSQL", "Other database"] }, { label: "Name" }, { label: "Environment", options: ENVIRONMENTS }],
  "Networking / DNS / Certificates": [{ label: "Domain" }, { label: "What is wrong", options: ["Missing record", "Certificate expired", "Migrate domain"] }],
  "Kubernetes": [{ label: "Cluster" }, { label: "Namespace" }, { label: "Environment", options: ENVIRONMENTS }],
  "ArgoCD": [{ label: "Cluster" }, { label: "Namespace" }, { label: "Environment", options: ENVIRONMENTS }],
};

export interface ServiceDeskCapability { repository: string; areas: string[]; severities: string[]; types: string[] }

export interface ServiceDeskRequest {
  areas: string[];
  severity: string;
  type: string;
  details?: Array<{ area: string; label: string; value: string }>;
}

export type FeedbackDestination =
  | { provider: "github"; repository: string }
  | { provider: "jira"; project: string };

/** Default platform areas; apps provide their own report features. */
export const DEFAULT_PLATFORM_FEEDBACK_FEATURES = [
  "Chat", "Connected Credentials", "Knowledge Bases", "Skills", "Workflows",
  "Agents", "MCP Servers", "LLM Models", "Schedules", "Settings", "Other",
];

export function parseFeedbackFeatures(value: unknown, label = "Feedback features"): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 32 ||
      value.some(item => typeof item !== "string" || !item.trim() || item.trim().length > 40)) {
    throw new Error(`${label} must contain 1–32 non-empty labels of up to 40 characters`);
  }
  return [...new Set(value.map(item => (item as string).trim()))];
}

export function platformFeedbackFeatures(raw: string | undefined): string[] {
  if (raw === undefined) return [...DEFAULT_PLATFORM_FEEDBACK_FEATURES];
  let value: unknown;
  try { value = JSON.parse(raw); }
  catch { throw new Error("FEEDBACK_FEATURES must be a JSON array of feature labels"); }
  return parseFeedbackFeatures(value, "FEEDBACK_FEATURES");
}

/** Browser family/major version and operating system, without the full user agent. */
export function describeFeedbackBrowser(ua: string): string {
  const browser = /Edg\/(\d+)/.exec(ua) ? ["Edge", /Edg\/(\d+)/.exec(ua)![1]]
    : /Firefox\/(\d+)/.exec(ua) ? ["Firefox", /Firefox\/(\d+)/.exec(ua)![1]]
    : /Chrome\/(\d+)/.exec(ua) ? ["Chrome", /Chrome\/(\d+)/.exec(ua)![1]]
    : /Version\/(\d+).*Safari/.exec(ua) ? ["Safari", /Version\/(\d+).*Safari/.exec(ua)![1]] : ["Unknown browser"];
  const os = /iPhone|iPad|iPod/.test(ua) ? "iOS" : /Android/.test(ua) ? "Android" : /Windows/.test(ua) ? "Windows" : /Mac OS X/.test(ua) ? "macOS" : /Linux/.test(ua) ? "Linux" : undefined;
  return browser.join(" ") + (os ? ` on ${os}` : "");
}
