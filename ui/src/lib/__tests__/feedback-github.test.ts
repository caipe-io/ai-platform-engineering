/** @jest-environment node */
jest.mock("@/lib/version", () => ({ readVersionInfo: () => ({ version: "1.2.3-test", gitCommit: "1".repeat(40) }) }));
jest.mock("@/lib/config", () => ({ getServerConfig: () => ({
  githubTicketRepo: "example/legacy", githubTicketLabel: "feedback", appName: "Platform",
}) }));
jest.mock("@/lib/api-middleware", () => ({ ApiError: class extends Error {
  constructor(message: string, public statusCode: number) { super(message); }
} }));
import { appGitHubFeedbackSettings, createGitHubFeedback, createPlatformGitHubFeedback, platformFeedbackCapabilities, platformFeedbackHandler } from "../feedback-github";

const keys = ["FEEDBACK_HANDLER", "FEEDBACK_GITHUB_REPO", "FEEDBACK_GITHUB_TOKEN", "FEEDBACK_GITHUB_LABEL",
  "FEEDBACK_GITHUB_SCREENSHOTS_REPO", "GITHUB_SCREENSHOTS_REPO", "GITHUB_TICKET_TOKEN", "REPORT_PROBLEM_GITHUB_TOKEN",
  "FEEDBACK_PLATFORM_LABEL", "FEEDBACK_FEATURES", "FEEDBACK_GITHUB_STYLE_JSON"];
const original = Object.fromEntries(keys.map(key => [key, process.env[key]]));
const originalFetch = global.fetch;
const request = { description: "Saving fails after opening the page.", title: "Save fails", issueType: "Bug", feature: "Chat",
  contextUrl: "https://host.example.test/chat", userEmail: "spoof@example.test", repo: "another/destination" };
const create = (change = {}, signal = new AbortController().signal) => createPlatformGitHubFeedback({ ...request, ...change }, "reporter@example.test", signal);
beforeEach(() => {
  keys.forEach(key => delete process.env[key]);
  process.env.FEEDBACK_HANDLER = "github";
  process.env.FEEDBACK_GITHUB_REPO = "example/feedback";
  process.env.FEEDBACK_GITHUB_TOKEN = "test-service-token";
  global.fetch = jest.fn().mockResolvedValue(Response.json({ number: 42, html_url: "https://github.com/example/feedback/issues/42" }, { status: 201 }));
});
afterAll(() => {
  keys.forEach(key => { if (original[key] === undefined) delete process.env[key]; else process.env[key] = original[key]; });
  global.fetch = originalFetch;
});
it("creates issues directly in the server-configured repository with canonical identity", async () => {
  expect(await create()).toEqual({ id: "#42", url: "https://github.com/example/feedback/issues/42", provider: "github" });
  const [url, options] = (global.fetch as jest.Mock).mock.calls[0];
  expect(url).toBe("https://api.github.com/repos/example/feedback/issues");
  expect(options.headers.Authorization).toBe("Bearer test-service-token");
  const body = JSON.parse(options.body);
  expect(body.title).toBe("Save fails");
  expect(body.labels).toEqual(["feedback", "bug"]);
  expect(body.body).toContain("reporter@example.test");
  expect(body.body).not.toContain("spoof@example.test");
  expect(body.body).not.toContain("test-service-token");
});
it("requires a dedicated platform repository and token instead of legacy provider settings", async () => {
  delete process.env.FEEDBACK_GITHUB_REPO;
  await expect(create()).rejects.toMatchObject({ statusCode: 503 });
  process.env.FEEDBACK_GITHUB_REPO = "example/feedback";
  delete process.env.FEEDBACK_GITHUB_TOKEN;
  process.env.REPORT_PROBLEM_GITHUB_TOKEN = "test-legacy-token";
  process.env.GITHUB_TICKET_TOKEN = "test-other-token";
  await expect(create()).rejects.toMatchObject({ statusCode: 503 });
  expect(global.fetch).not.toHaveBeenCalled();
});
it("requires an explicit handler and rejects unknown handlers", () => {
  delete process.env.FEEDBACK_HANDLER;
  expect(platformFeedbackHandler).toThrow("not configured");
  expect(platformFeedbackCapabilities).toThrow("not configured");
  process.env.FEEDBACK_HANDLER = "agent";
  expect(platformFeedbackHandler()).toBe("agent");
  process.env.FEEDBACK_HANDLER = "unknown";
  expect(platformFeedbackHandler).toThrow("Unsupported");
});
it.each(["https://example.test/repo", "../repo", "example/..", "example/repo/extra", ""])("rejects invalid repository %s without making requests", async repo => {
  process.env.FEEDBACK_GITHUB_REPO = repo || " ";
  await expect(create()).rejects.toMatchObject({ statusCode: 503 });
  expect(global.fetch).not.toHaveBeenCalled();
});
it("rejects missing credentials before any provider writes", async () => {
  delete process.env.FEEDBACK_GITHUB_TOKEN;
  await expect(create()).rejects.toMatchObject({ statusCode: 503 });
  expect(global.fetch).not.toHaveBeenCalled();
});
it.each([{ description: "" }, { title: "x".repeat(121) }, { issueType: "invalid" }, { contextUrl: "javascript:alert(1)" },
  { feature: "Unregistered" }, { chatContext: "x".repeat(14001) }, { screenshotDataUrl: "data:image/png;base64,AQID" }])("rejects invalid or unsupported feedback %j before writes", async change => {
  await expect(create(change)).rejects.toMatchObject({ statusCode: 400 });
  expect(global.fetch).not.toHaveBeenCalled();
});
it("reports screenshot capability and uploads before creating the issue", async () => {
  expect(platformFeedbackCapabilities()).toEqual({ screenshotsEnabled: false });
  process.env.FEEDBACK_GITHUB_SCREENSHOTS_REPO = "example/assets";
  expect(platformFeedbackCapabilities()).toEqual({ screenshotsEnabled: true });
  (global.fetch as jest.Mock).mockResolvedValueOnce(Response.json({ content: { html_url: "https://github.com/example/assets/blob/main/feedback/image.png?token=temporary" } }));
  await create({ screenshotDataUrl: "data:image/png;base64,AQID" });
  const calls = (global.fetch as jest.Mock).mock.calls;
  expect(calls[0][0]).toMatch(/^https:\/\/api.github.com\/repos\/example\/assets\/contents\/feedback\/.*\.png$/);
  expect(calls[1][0]).toBe("https://api.github.com/repos/example/feedback/issues");
  expect(JSON.parse(calls[1][1].body).body).toContain("image.png?raw=1");
  expect(JSON.parse(calls[1][1].body).body).not.toContain("temporary");
});
it("does not retry failed GitHub issue creation", async () => {
  (global.fetch as jest.Mock).mockResolvedValue(Response.json({ message: "Forbidden" }, { status: 403 }));
  const log = jest.spyOn(console, "error").mockImplementation(() => {});
  try { await expect(create()).rejects.toMatchObject({ statusCode: 502 }); }
  finally { log.mockRestore(); }
  expect(global.fetch).toHaveBeenCalledTimes(1);
});
it("does not create an issue after cancellation during an image upload", async () => {
  process.env.FEEDBACK_GITHUB_SCREENSHOTS_REPO = "example/assets";
  const controller = new AbortController();
  (global.fetch as jest.Mock).mockImplementationOnce(async () => {
    controller.abort();
    return Response.json({ content: { html_url: "https://github.com/example/assets/blob/main/image.png" } });
  });
  await expect(create({ screenshotDataUrl: "data:image/png;base64,AQID" }, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
  expect(global.fetch).toHaveBeenCalledTimes(1);
});

it("rejects malformed provider receipts without retrying creation", async () => {
  (global.fetch as jest.Mock).mockResolvedValue(Response.json(null, { status: 201 }));
  await expect(create()).rejects.toMatchObject({ statusCode: 502 });
  expect(global.fetch).toHaveBeenCalledTimes(1);
});


it("uses each app's configured destination and credential through the same provider", async () => {
  const app = { installation: { feedbackGitHub: { repository: "example/product", tokenEnv: "FEEDBACK_EXAMPLE_TOKEN" }, feedbackFeatures: ["Publishing"] }, manifest: { displayName: "Example App" } };
  process.env.FEEDBACK_EXAMPLE_TOKEN = "test-app-token";
  try {
    const settings = appGitHubFeedbackSettings(app as Parameters<typeof appGitHubFeedbackSettings>[0]);
    await createGitHubFeedback({ description: "Publishing fails", contextUrl: "https://example.test", feature: "Publishing", repository: "ignored/repo" }, "reporter@example.test", new AbortController().signal, settings);
    expect(global.fetch).toHaveBeenCalledWith("https://api.github.com/repos/example/product/issues", expect.objectContaining({ headers: expect.objectContaining({ Authorization: "Bearer test-app-token" }) }));
    await expect(createGitHubFeedback({ description: "Invalid feature", contextUrl: "https://example.test", feature: "Chat" }, "reporter@example.test", new AbortController().signal, settings)).rejects.toMatchObject({ statusCode: 400 });
    delete process.env.FEEDBACK_EXAMPLE_TOKEN;
    expect(() => appGitHubFeedbackSettings(app as Parameters<typeof appGitHubFeedbackSettings>[0])).toThrow("not configured");
  } finally { delete process.env.FEEDBACK_EXAMPLE_TOKEN; }
});


it("records valid impact choices and rejects unknown impact before provider writes", async () => {
  await create({ severity: "Blocks my work" });
  expect(JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body).body).toContain("- Impact: Blocks my work");
  (global.fetch as jest.Mock).mockClear();
  await expect(create({ severity: "Unknown" })).rejects.toMatchObject({ statusCode: 400 });
  expect(global.fetch).not.toHaveBeenCalled();
});


it("uses deployment title and label rules, records diagnostics, and ignores caller routing labels", async () => {
  process.env.FEEDBACK_PLATFORM_LABEL = "Example";
  process.env.FEEDBACK_FEATURES = JSON.stringify(["Publishing", "Other"]);
  process.env.FEEDBACK_GITHUB_STYLE_JSON = JSON.stringify({ titlePrefix: true, labels: ["user-feedback", "area:example"],
    typeLabels: { Bug: "bug", Enhancement: "feature" }, featureLabels: { Publishing: "feature:publishing" },
    contextFields: { projectSlug: "Project", pagePath: "Wiki page", appVersion: "App build" } });
  await create({ issueType: "Enhancement", feature: "Publishing", labels: ["critical"], assignees: ["unrelated-user"], build: "forged-build",
    browser: "Example Browser 12 on Example OS", source: "app", relatedUrl: "https://example.test/related",
    appContext: { projectSlug: "example-project", pagePath: "guides/example", appVersion: "2.3.4-test", ignored: "not included" } });
  const data = JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body);
  expect(data.title).toBe("[User Feedback][Example][Enhancement]: Save fails");
  expect(data.labels).toEqual(["user-feedback", "area:example", "feature", "feature:publishing"]);
  expect(data.assignees).toBeUndefined();
  for (const entry of ["Host build: 1.2.3-test", "Host commit: " + "1".repeat(40), "Browser: Example Browser 12 on Example OS", "Entry point: app", "Project: example-project", "Wiki page: guides/example", "Related link: https://example.test/related", "App build: 2.3.4-test"]) expect(data.body).toContain(entry);
  expect(data.body).not.toContain("forged-build");
  expect(data.body).not.toContain("not included");
});

it.each([{ labels: "invalid" }, { typeLabels: { Incident: "bug" } }, { titlePrefix: "yes" }, { labels: ["bad\nlabel"] }])("rejects invalid deployment style before provider writes: %j", async style => {
  process.env.FEEDBACK_GITHUB_STYLE_JSON = JSON.stringify(style);
  await expect(create()).rejects.toMatchObject({ statusCode: 503 });
  expect(global.fetch).not.toHaveBeenCalled();
});

it.each([{ browser: "x".repeat(201) }, { source: "unknown" }, { relatedUrl: "javascript:alert(1)" }, { appContext: { projectSlug: 42 } }])("validates optional diagnostics before provider writes: %j", async change => {
  await expect(create(change)).rejects.toMatchObject({ statusCode: 400 });
  expect(global.fetch).not.toHaveBeenCalled();
});
