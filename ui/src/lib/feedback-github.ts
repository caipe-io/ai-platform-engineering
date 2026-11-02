import { randomUUID } from "crypto";
import { parseFeedbackIssueStyle, parseFeedbackAppContext } from "@/lib/feedback-issue-style";
import { readVersionInfo } from "@/lib/version";

import { ApiError } from "@/lib/api-middleware";
import { getServerConfig } from "@/lib/config";
import type { ConfiguredAgenticApp } from "@/types/agentic-app";
import { FEEDBACK_SEVERITIES, platformFeedbackFeatures } from "@/lib/feedback-features";

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
  return { repo, token, style, assets: assets ? repository(assets) : undefined,
    label: process.env.FEEDBACK_GITHUB_LABEL || cfg.githubTicketLabel,
    component: process.env.FEEDBACK_PLATFORM_LABEL || cfg.appName, features: platformFeedbackFeatures(process.env.FEEDBACK_FEATURES) };
}

export function platformFeedbackCapabilities(): { screenshotsEnabled?: boolean } {
  return platformFeedbackHandler() === "github" ? { screenshotsEnabled: Boolean(settings().assets) } : {};
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
