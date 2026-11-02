export const FEEDBACK_SEVERITIES = ["Blocks my work", "Annoying", "Minor"] as const;
export type FeedbackSeverity = (typeof FEEDBACK_SEVERITIES)[number];

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
