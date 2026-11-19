import { randomUUID } from "crypto";
import { parseFeedbackIssueStyle, parseFeedbackAppContext } from "@/lib/feedback-issue-style";
import { readVersionInfo } from "@/lib/version";

import { ApiError } from "@/lib/api-middleware";
import { getServerConfig } from "@/lib/config";
import type { ConfiguredAgenticApp } from "@/types/agentic-app";
import { FEEDBACK_SEVERITIES, SERVICE_DESK_AREAS, SERVICE_DESK_DETAILS, SERVICE_DESK_SEVERITIES, SERVICE_DESK_TYPES, platformFeedbackFeatures, type FeedbackDestination, type ServiceDeskCapability, type ServiceDeskRequest } from "@/lib/feedback-features";

export function platformFeedbackHandler(): "agent" | "github" {
  const handler = process.env.FEEDBACK_HANDLER;
  if (!handler) throw new ApiError("The platform feedback handler is not configured", 503);
  if (handler !== "agent" && handler !== "github") throw new ApiError("Unsupported platform feedback handler", 503);
  return handler;
}

function repository(value: string | undefined | null): string {
  if (!value || !/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_.-]+$/.test(value.trim()) || [".", ".."].includes(value.trim().split("/")[1])) {
    throw new ApiError("Configure a feedback GitHub repository as owner/repo", 503);
  }
  return value.trim();
}

function settings() {
  const cfg = getServerConfig();
  const repo = repository(process.env.FEEDBACK_GITHUB_REPO);
  const token = process.env.FEEDBACK_GITHUB_TOKEN?.trim();
  if (!token) throw new ApiError("The platform feedback GitHub service token is not configured", 503);
  const assets = process.env.FEEDBACK_GITHUB_SCREENSHOTS_REPO;
  let style;
  try { style = parseFeedbackIssueStyle(process.env.FEEDBACK_GITHUB_STYLE_JSON ? JSON.parse(process.env.FEEDBACK_GITHUB_STYLE_JSON) : {}); }
  catch { throw new ApiError("Invalid feedback GitHub style configuration", 503); }
  let features;
  try { features = platformFeedbackFeatures(process.env.FEEDBACK_FEATURES); }
  catch { throw new ApiError("Invalid feedback feature configuration", 503); }
  return { repo, token, style, assets: assets ? repository(assets) : undefined,
    label: process.env.FEEDBACK_GITHUB_LABEL || cfg.githubTicketLabel,
    component: process.env.FEEDBACK_PLATFORM_LABEL || cfg.appName, features };
}

const SERVICE_DESK_DETAIL_FIELD_COUNT = Object.values(SERVICE_DESK_DETAILS).reduce((total, fields) => total + fields.length, 0);
let warnedServiceDeskMisconfigured = false;

function serviceDeskSettings() {
  const env = process.env;
  const repo = env.FEEDBACK_SERVICE_DESK_REPO || env.FEEDBACK_GITHUB_REPO;
  const token = (env.FEEDBACK_SERVICE_DESK_TOKEN || env.FEEDBACK_GITHUB_TOKEN)?.trim();
  return { repo, token, label: env.FEEDBACK_SERVICE_DESK_LABEL?.trim() || "service-desk" };
}

/** Opt-in with FEEDBACK_SERVICE_DESK_ENABLED=true or a dedicated repository; repository and token fall back to the feedback ones. A bad setting hides it instead of failing feedback. */
export function serviceDeskCapabilities(): ServiceDeskCapability | undefined {
  const env = process.env;
  if (env.FEEDBACK_HANDLER !== "github" || !(env.FEEDBACK_SERVICE_DESK_ENABLED === "true" || env.FEEDBACK_SERVICE_DESK_REPO)) return undefined;
  const { repo, token } = serviceDeskSettings();
  const unusable = () => {
    if (env.FEEDBACK_SERVICE_DESK_ENABLED === "true" && !warnedServiceDeskMisconfigured) {
      warnedServiceDeskMisconfigured = true;
      console.warn("FEEDBACK_SERVICE_DESK_ENABLED is true but the service desk token or repository is missing or invalid; Request help is hidden.");
    }
    return undefined;
  };
  if (!token) return unusable();
  try { return { repository: repository(repo), areas: [...SERVICE_DESK_AREAS], severities: [...SERVICE_DESK_SEVERITIES], types: [...SERVICE_DESK_TYPES] }; }
  catch { return unusable(); }
}

export function platformFeedbackCapabilities(): { screenshotsEnabled?: boolean; destination?: FeedbackDestination; serviceDesk?: ServiceDeskCapability; feedbackEnabled?: boolean } {
  if (platformFeedbackHandler() === "github") {
    const serviceDesk = serviceDeskCapabilities();
    try {
      const cfg = settings();
      return { screenshotsEnabled: Boolean(cfg.assets), destination: { provider: "github", repository: cfg.repo }, serviceDesk };
    } catch (error) {
      if (!(error instanceof ApiError && error.statusCode === 503) || !serviceDesk) throw error;
      return { serviceDesk, feedbackEnabled: false };
    }
  }
  const cfg = getServerConfig();
  if (!cfg.ticketEnabled || !(cfg.ticketProvider === "jira" ? cfg.jiraTicketProject : cfg.ticketProvider === "github" ? cfg.githubTicketRepo : undefined)?.trim()) {
    throw new ApiError("The platform feedback agent's ticket provider is not configured", 503);
  }
  return { destination: cfg.ticketProvider === "jira"
    ? { provider: "jira", project: cfg.jiraTicketProject!.trim() }
    : { provider: "github", repository: repository(cfg.githubTicketRepo) } };
}

export function appGitHubFeedbackSettings(app: ConfiguredAgenticApp) {
  const handler = app.installation.feedbackGitHub;
  if (!handler) throw new ApiError("Component feedback handler is not configured", 503);
  const token = process.env[handler.tokenEnv]?.trim();
  if (!token || !app.installation.feedbackFeatures?.length) throw new ApiError("Component feedback credential or features are not configured", 503);
  return { repo: repository(handler.repository), token, style: handler.style ?? {},
    assets: handler.screenshotsRepository ? repository(handler.screenshotsRepository) : undefined,
    label: handler.label || "feedback", component: app.manifest.displayName, features: app.installation.feedbackFeatures };
}

export const createPlatformGitHubFeedback = async (input: unknown, reporter: string, signal: AbortSignal) =>
  createGitHubFeedback(input, reporter, signal, settings());

function text(value: unknown, name: string, max: number, required = false): string | undefined {
  if (value === undefined && !required) return undefined;
  if (typeof value !== "string" || value.length > max || required && !value.trim()) throw new ApiError(`Invalid ${name}`, 400);
  return value.trim();
}

async function github(path: string, method: "POST" | "PUT", payload: object, token: string, signal: AbortSignal) {
  signal.throwIfAborted();
  let response: Response;
  try {
    response = await fetch(`https://api.github.com/repos/${path}`, {
      method, headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json",
        "Content-Type": "application/json", "X-GitHub-Api-Version": "2026-03-10" },
      body: JSON.stringify(payload), redirect: "error",
      signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
    });
  } catch (error) {
    if (signal.aborted) throw error;
    throw new ApiError("GitHub did not confirm the feedback request. Please retry.", 502);
  }
  if (!response.ok) {
    console.error("[feedback/github] Request failed", { status: response.status });
    throw new ApiError("GitHub could not create the feedback issue. Check the configured repository and service token permissions.", 502);
  }
  return response.json().catch(() => { throw new ApiError("GitHub returned an invalid feedback response", 502); });
}

/** The destination and credential come exclusively from platform-owned configuration. */
export async function createGitHubFeedback(input: unknown, reporter: string, signal: AbortSignal, cfg: ReturnType<typeof settings>) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new ApiError("Invalid feedback body", 400);
  const data = input as Record<string, unknown>;
  const description = text(data.description, "description", 20000, true)!;
  const shortTitle = text(data.title, "title", 120) || description.split("\n")[0].slice(0, 120);
  const context = text(data.contextUrl, "context URL", 2000, true)!;
  try { if (!["http:", "https:"].includes(new URL(context).protocol)) throw new Error("protocol"); }
  catch { throw new ApiError("Provide a valid context URL", 400); }
  const issueType = data.issueType ?? "Bug";
  if (issueType !== "Bug" && issueType !== "Enhancement") throw new ApiError("Choose Bug or Enhancement", 400);
  const feature = text(data.feature, "feature", 40);
  if (feature && !cfg.features.includes(feature)) throw new ApiError("Choose a configured feedback feature", 400);
  const severity = text(data.severity, "impact", 40);
  if (severity && !FEEDBACK_SEVERITIES.some(value => value === severity)) throw new ApiError("Choose a valid feedback impact", 400);
  const chat = text(data.chatContext, "chat context", 14000);
  const feedback = data.feedbackContext as Record<string, unknown> | undefined;
  const reason = text(feedback?.reason, "feedback reason", 1000);
  const additional = text(feedback?.additionalFeedback, "additional feedback", 20000);
  const browser = text(data.browser, "browser", 200);
  const source = text(data.source, "entry point", 40);
  if (source && !["header", "app", "chat-feedback"].includes(source)) throw new ApiError("Invalid feedback entry point", 400);
  const relatedUrl = text(data.relatedUrl, "related link", 2000);
  if (relatedUrl) {
    try { if (!["http:", "https:"].includes(new URL(relatedUrl).protocol)) throw new Error("protocol"); }
    catch { throw new ApiError("Provide a valid related link", 400); }
  }
  let appContext: Record<string, string> | undefined;
  try { appContext = parseFeedbackAppContext(data.appContext); }
  catch { throw new ApiError("Invalid feedback application context", 400); }
  let build;
  try { build = readVersionInfo(); }
  catch { console.warn("[feedback/github] Host build metadata is unavailable"); build = { version: "unknown", gitCommit: "unknown" }; }
  const style = cfg.style;
  const title = style.titlePrefix
    ? `[User Feedback][${cfg.component.replace(/[\r\n\[\]]/g, " ").trim().slice(0, 60)}][${issueType}]: ${shortTitle}`.slice(0, 240) : shortTitle;
  const labels = [...new Set([...(style.labels ?? [cfg.label]), style.typeLabels?.[issueType] ?? issueType.toLowerCase(),
    feature && Object.hasOwn(style.featureLabels ?? {}, feature) ? style.featureLabels![feature] : undefined].filter((value): value is string => Boolean(value)))];
  const customContext = Object.entries(style.contextFields ?? {}).flatMap(([key, label]) => appContext && Object.hasOwn(appContext, key) ? [`- ${label}: ${appContext[key]}`] : []);
  const body = ["## Summary", "", description, "", "## Feedback details", `- Component: ${cfg.component}`, `- Type: ${issueType}`,
    feature && `- Feature: ${feature}`, severity && `- Impact: ${severity}`, `- Reporter: ${reporter}`, `- Page: ${context}`,
    relatedUrl && `- Related link: ${relatedUrl}`, `- Entry point: ${source ?? "Provide Feedback"}`,
    `- Host build: ${build.version}`, `- Host commit: ${build.gitCommit}`, browser && `- Browser: ${browser}`, ...customContext,
    reason && `- Response feedback: ${reason}`, additional,
    chat && "\n## Reporter-approved chat excerpt", chat,
    "", "---", "_Submitted via CAIPE Provide Feedback_"].filter((value): value is string => typeof value === "string");
  if (body.join("\n").length > 58000) throw new ApiError("The feedback report is too long", 400);
  if (data.screenshotDataUrl !== undefined) {
    if (!cfg.assets) throw new ApiError("Screenshot uploads are not configured for this component", 400);
    const screenshot = text(data.screenshotDataUrl, "screenshot", 7_000_000, true)!;
    const match = screenshot.match(/^data:image\/(png|jpeg|webp|gif);base64,([A-Za-z0-9+/]+={0,2})$/);
    if (!match || Buffer.from(match[2], "base64").toString("base64") !== match[2] || Buffer.from(match[2], "base64").length > 5_000_000) throw new ApiError("Attach a supported image smaller than 5 MB", 400);
    const path = `feedback/${randomUUID()}.${match[1] === "jpeg" ? "jpg" : match[1]}`;
    const uploaded = await github(`${cfg.assets}/contents/${path}`, "PUT", { message: "Upload feedback screenshot", content: match[2] }, cfg.token, signal);
    let image: URL;
    try { image = new URL(uploaded.content?.html_url); }
    catch { throw new ApiError("GitHub did not return a screenshot link", 502); }
    if (image.origin !== "https://github.com" || !image.pathname.toLowerCase().startsWith(`/${cfg.assets.toLowerCase()}/blob/`)) throw new ApiError("GitHub returned an invalid screenshot link", 502);
    image.search = "?raw=1";
    body.push("", "## Screenshot", `![Feedback screenshot](${image.href})`);
  }
  const issue = await github(`${cfg.repo}/issues`, "POST", { title, body: body.join("\n"),
    labels }, cfg.token, signal);
  if (!Number.isSafeInteger(issue?.number) || issue.number < 1) throw new ApiError("GitHub did not return an issue receipt", 502);
  return { id: `#${issue.number}`, url: `https://github.com/${cfg.repo}/issues/${issue.number}`, provider: "github" as const };
}

function oneOf(value: unknown, allowed: readonly string[], name: string): string {
  if (typeof value !== "string" || !allowed.includes(value)) throw new ApiError(`Choose a valid ${name}`, 400);
  return value;
}

const TITLE_MAX = 120;

/** One line for a table cell or bullet value: whitespace collapsed, backslashes, pipes and backticks escaped. */
function cell(value: string): string {
  return value.replace(/\s+/g, " ").trim().replace(/[\\|`]/g, "\\$&");
}

function serviceDeskTitle(areas: string[], title: string): string {
  const prefix = areas.length > 1 ? "[Multiple areas]" : `[${areas[0]}]`;
  const clean = title.replace(/[\r\n[\]]+/g, " ").replace(/\s+/g, " ").trim();
  const room = TITLE_MAX - prefix.length - 1;
  if (clean.length <= room) return `${prefix} ${clean}`;
  if (room < 2) return prefix;
  let cut = clean.slice(0, room - 1);
  if (!/\s/.test(clean[room - 1])) cut = cut.includes(" ") ? cut.slice(0, cut.lastIndexOf(" ")) : cut;
  return `${prefix} ${cut.trimEnd()}\u2026`;
}

/** Inserts a zero-width space after an @ followed by a letter or digit, outside fenced code. */
function neutraliseMentions(markdown: string): string {
  let fence: string | undefined;
  return markdown.split("\n").map(line => {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})/)?.[1];
    if (fence) { if (marker && marker[0] === fence[0] && marker.length >= fence.length) fence = undefined; return line; }
    if (marker) { fence = marker; return line; }
    return line.replace(/@(?=[A-Za-z0-9])/g, "@\u200B");
  }).join("\n");
}

export async function createServiceDeskTicket(input: unknown, reporter: string, signal: AbortSignal) {
  const capability = serviceDeskCapabilities();
  const { token, label } = serviceDeskSettings();
  if (!capability || !token) throw new ApiError("Request help is not configured", 503);
  const cfg = { repo: capability.repository, token, label };
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new ApiError("Invalid request body", 400);
  const data = input as Record<string, unknown>;
  const title = text(data.title, "title", 120, true)!;
  const description = text(data.description, "description", 4000, true)!;
  const context = text(data.contextUrl, "context URL", 2000, true)!.split(/\s+/)[0];
  try { if (!["http:", "https:"].includes(new URL(context).protocol)) throw new Error("protocol"); }
  catch { throw new ApiError("Provide a valid context URL", 400); }
  const raw = data.serviceDesk as Partial<ServiceDeskRequest> | undefined;
  if (!raw || typeof raw !== "object") throw new ApiError("Invalid request details", 400);
  if (!Array.isArray(raw.areas) || !raw.areas.length) throw new ApiError("Choose an area of impact", 400);
  const areas = [...new Set(raw.areas.map(area => oneOf(area, capability.areas, "area of impact")))];
  const severity = oneOf(raw.severity, capability.severities, "severity");
  const type = oneOf(raw.type, capability.types, "type");
  const detailLines = new Map<string, string[]>();
  for (const item of (Array.isArray(raw.details) ? raw.details : []).slice(0, SERVICE_DESK_DETAIL_FIELD_COUNT)) {
    const field = typeof item?.area === "string" && Object.hasOwn(SERVICE_DESK_DETAILS, item.area)
      ? SERVICE_DESK_DETAILS[item.area].find(candidate => candidate.label === item.label) : undefined;
    if (!field || !areas.includes(item.area)) throw new ApiError("Invalid request detail", 400);
    const value = text(item.value, "detail value", 500);
    if (!value) continue;
    if (field.options && !field.options.includes(value)) throw new ApiError("Invalid request detail", 400);
    detailLines.set(item.area, [...detailLines.get(item.area) ?? [], `- **${field.label}:** ${cell(value).replace(/@(?=[A-Za-z0-9])/g, "@\u200B")}`]);
  }
  const body = ["| Area | Reported severity | Type | Requested by |", "| --- | --- | --- | --- |",
    `| ${[areas.join(", "), severity, type, reporter].map(cell).join(" | ")} |`,
    "", "## Description", "", neutraliseMentions(description),
    ...areas.filter(area => detailLines.has(area)).flatMap((area, index) => [...index ? [] : ["", "## Details"], "", `**${area}**`, ...detailLines.get(area)!]),
    "", "---", `<sub>Submitted from <${new URL(context).href}> via CAIPE Provide Feedback</sub>`];
  if (body.join("\n").length > 58000) throw new ApiError("The request is too long", 400);
  const issue = await github(`${cfg.repo}/issues`, "POST", { title: serviceDeskTitle(areas, title), body: body.join("\n"),
    labels: [cfg.label, "caipe-reported"] }, cfg.token, signal);
  if (!Number.isSafeInteger(issue?.number) || issue.number < 1) throw new ApiError("GitHub did not return an issue receipt", 502);
  return { id: `#${issue.number}`, url: `https://github.com/${cfg.repo}/issues/${issue.number}`, provider: "github" as const };
}
