/** @jest-environment node */
let mockAgentConfig: { ticketEnabled: boolean; ticketProvider: string | null; jiraTicketProject: string | null };
jest.mock("@/lib/version", () => ({ readVersionInfo: () => ({ version: "1.2.3-test", gitCommit: "1".repeat(40) }) }));
jest.mock("@/lib/config", () => ({ getServerConfig: () => ({
  githubTicketRepo: "example/legacy", githubTicketLabel: "feedback", appName: "Platform",
  ...mockAgentConfig,
}) }));
jest.mock("@/lib/api-middleware", () => ({ ApiError: class extends Error {
  constructor(message: string, public statusCode: number) { super(message); }
} }));
import { SERVICE_DESK_AREAS, SERVICE_DESK_DETAILS, SERVICE_DESK_SEVERITIES, SERVICE_DESK_TYPES } from "../feedback-features";
import { appGitHubFeedbackSettings, createGitHubFeedback, createPlatformGitHubFeedback, createServiceDeskTicket, platformFeedbackCapabilities, platformFeedbackHandler, serviceDeskCapabilities } from "../feedback-github";

const keys = ["FEEDBACK_HANDLER", "FEEDBACK_GITHUB_REPO", "FEEDBACK_GITHUB_TOKEN", "FEEDBACK_GITHUB_LABEL",
  "FEEDBACK_GITHUB_SCREENSHOTS_REPO", "GITHUB_SCREENSHOTS_REPO", "GITHUB_TICKET_TOKEN", "REPORT_PROBLEM_GITHUB_TOKEN",
  "FEEDBACK_PLATFORM_LABEL", "FEEDBACK_FEATURES", "FEEDBACK_GITHUB_STYLE_JSON",
  "FEEDBACK_SERVICE_DESK_ENABLED", "FEEDBACK_SERVICE_DESK_REPO", "FEEDBACK_SERVICE_DESK_TOKEN", "FEEDBACK_SERVICE_DESK_LABEL"];
const original = Object.fromEntries(keys.map(key => [key, process.env[key]]));
const originalFetch = global.fetch;
const request = { description: "Saving fails after opening the page.", title: "Save fails", issueType: "Bug", feature: "Chat",
  contextUrl: "https://host.example.test/chat", userEmail: "spoof@example.test", repo: "another/destination" };
const create = (change = {}, signal = new AbortController().signal) => createPlatformGitHubFeedback({ ...request, ...change }, "reporter@example.test", signal);
beforeEach(() => {
  mockAgentConfig = { ticketEnabled: true, ticketProvider: "jira", jiraTicketProject: "TEST" };
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
  expect(platformFeedbackCapabilities()).toEqual({ screenshotsEnabled: false, destination: { provider: "github", repository: "example/feedback" } });
  process.env.FEEDBACK_GITHUB_SCREENSHOTS_REPO = "example/assets";
  expect(platformFeedbackCapabilities()).toEqual({ screenshotsEnabled: true, destination: { provider: "github", repository: "example/feedback" } });
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

it("keeps an explicitly configured Jira agent available", () => {
  process.env.FEEDBACK_HANDLER = "agent";
  expect(platformFeedbackCapabilities()).toEqual({ destination: { provider: "jira", project: "TEST" } });
});
it.each([{ ticketEnabled: false }, { ticketProvider: null }, { jiraTicketProject: " " }])("rejects an unconfigured agent destination: %j", change => {
  process.env.FEEDBACK_HANDLER = "agent";
  Object.assign(mockAgentConfig, change);
  expect(platformFeedbackCapabilities).toThrow("ticket provider is not configured");
});

describe("Request help", () => {
  const ticket = { title: "Add me to the team", description: "New contributor.", contextUrl: "https://host.example.test/chat",
    serviceDesk: { areas: ["GitHub", "Vault"], severity: "High", type: "Ticket" } };
  const create = (change = {}) => createServiceDeskTicket({ ...ticket, ...change }, "reporter@example.test", new AbortController().signal);
  beforeEach(() => {
    process.env.FEEDBACK_SERVICE_DESK_REPO = "example/service-desk";
    process.env.FEEDBACK_SERVICE_DESK_TOKEN = "test-service-desk-token";
  });
  it("is offered only with its own repository", () => {
    expect(serviceDeskCapabilities()).toMatchObject({ repository: "example/service-desk" });
    expect(platformFeedbackCapabilities().serviceDesk).toMatchObject({ repository: "example/service-desk" });
    delete process.env.FEEDBACK_SERVICE_DESK_REPO;
    expect(serviceDeskCapabilities()).toBeUndefined();
    process.env.FEEDBACK_SERVICE_DESK_REPO = "not a repository";
    expect(serviceDeskCapabilities()).toBeUndefined();
    expect(() => platformFeedbackCapabilities()).not.toThrow();
    process.env.FEEDBACK_SERVICE_DESK_REPO = "example/service-desk";
    delete process.env.FEEDBACK_SERVICE_DESK_TOKEN;
    expect(serviceDeskCapabilities()).toBeDefined();
    delete process.env.FEEDBACK_GITHUB_TOKEN;
    expect(serviceDeskCapabilities()).toBeUndefined();
    process.env.FEEDBACK_SERVICE_DESK_TOKEN = "test-service-desk-token";
    process.env.FEEDBACK_HANDLER = "agent";
    expect(serviceDeskCapabilities()).toBeUndefined();
  });
  it.each(["missing", "invalid", "features", "style"])("supports dedicated help credentials with %s ordinary settings", async ordinary => {
    if (ordinary === "missing") {
      delete process.env.FEEDBACK_GITHUB_REPO;
      delete process.env.FEEDBACK_GITHUB_TOKEN;
    } else if (ordinary === "features") {
      process.env.FEEDBACK_FEATURES = "not JSON";
    } else if (ordinary === "style") {
      process.env.FEEDBACK_GITHUB_STYLE_JSON = "not JSON";
    } else {
      process.env.FEEDBACK_GITHUB_REPO = "invalid repository";
    }
    expect(platformFeedbackCapabilities()).toMatchObject({ feedbackEnabled: false, serviceDesk: { repository: "example/service-desk" } });
    expect(platformFeedbackCapabilities().destination).toBeUndefined();
    await create();
    expect((global.fetch as jest.Mock).mock.calls[0][0]).toBe("https://api.github.com/repos/example/service-desk/issues");
  });
  it("preserves literal backslashes in request details", async () => {
    const value = String.raw`\\fileserver\share\folder`;
    await create({ serviceDesk: { ...ticket.serviceDesk, areas: ["Compute"], details: [{ area: "Compute", label: "Resource", value }] } });
    expect(sent().body).toContain(String.raw`- **Resource:** \\\\fileserver\\share\\folder`);
  });
  it("accepts the full catalogue of detail fields without truncation", async () => {
    const entries = Object.entries(SERVICE_DESK_DETAILS);
    const details = entries.flatMap(([area, fields]) => fields.map(field => ({ area, label: field.label, value: field.options?.[0] ?? "x" })));
    expect(details.length).toBeGreaterThan(24);
    await create({ serviceDesk: { ...ticket.serviceDesk, areas: entries.map(([area]) => area), details } });
    const body = JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body).body as string;
    for (const { label } of details) expect(body).toContain(`- **${label}:** `);
    expect(body.match(/^- \*\*[^:\n]+:\*\* /gm)!.length).toBeGreaterThanOrEqual(details.length);
  });
  it("warns once, naming the flag but not a value, when the flag is on and the setup is unusable", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    let isolated!: typeof import("../feedback-github");
    await jest.isolateModulesAsync(async () => { isolated = await import("../feedback-github"); });
    delete process.env.FEEDBACK_SERVICE_DESK_REPO;
    delete process.env.FEEDBACK_SERVICE_DESK_TOKEN;
    process.env.FEEDBACK_SERVICE_DESK_ENABLED = "true";
    process.env.FEEDBACK_GITHUB_REPO = "not a repository";
    expect(isolated.serviceDeskCapabilities()).toBeUndefined();
    expect(isolated.serviceDeskCapabilities()).toBeUndefined();
    delete process.env.FEEDBACK_GITHUB_TOKEN;
    expect(isolated.serviceDeskCapabilities()).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain("FEEDBACK_SERVICE_DESK_ENABLED");
    expect(warn.mock.calls[0][0]).not.toContain("not a repository");
    warn.mockRestore();
  });
  it("can be enabled with a flag and reuses the feedback repository and token", async () => {
    delete process.env.FEEDBACK_SERVICE_DESK_REPO;
    delete process.env.FEEDBACK_SERVICE_DESK_TOKEN;
    expect(serviceDeskCapabilities()).toBeUndefined();
    process.env.FEEDBACK_SERVICE_DESK_ENABLED = "true";
    expect(serviceDeskCapabilities()).toMatchObject({ repository: "example/feedback" });
    await create();
    const [url, options] = (global.fetch as jest.Mock).mock.calls[0];
    expect(url).toBe("https://api.github.com/repos/example/feedback/issues");
    expect(options.headers.Authorization).toBe("Bearer test-service-token");
  });
  it("offers the agent form's option lists", () => {
    expect(serviceDeskCapabilities()).toEqual({ repository: "example/service-desk",
      areas: [...SERVICE_DESK_AREAS], severities: [...SERVICE_DESK_SEVERITIES], types: [...SERVICE_DESK_TYPES] });
  });
  it("writes the optional details after the description", async () => {
    await create({ serviceDesk: { ...ticket.serviceDesk, areas: ["Vault"], details: [
      { area: "Vault", label: "Namespace path", value: "example/apps/demo" },
      { area: "Vault", label: "Role", value: "Admin" },
      { area: "Vault", label: "Environment", value: "" },
    ] } });
    const body = JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body).body;
    expect(body).toContain("## Details\n\n**Vault**\n- **Namespace path:** example/apps/demo\n- **Role:** Admin");
    expect(body).not.toContain("Environment");
    expect(body.indexOf("## Details")).toBeGreaterThan(body.indexOf("New contributor."));
  });
  it("groups details under their area in the order the areas were chosen", async () => {
    await create({ serviceDesk: { ...ticket.serviceDesk, areas: ["Vault", "AI / ML"], details: [
      { area: "AI / ML", label: "Key type", value: "Team" },
      { area: "Vault", label: "Role", value: "Admin" },
      { area: "AI / ML", label: "Current monthly limit ($)", value: "1200" },
    ] } });
    const body = JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body).body;
    expect(body).toContain("## Details\n\n**Vault**\n- **Role:** Admin\n\n**AI / ML**\n- **Key type:** Team\n- **Current monthly limit ($):** 1200");
    expect(body).not.toContain("AI / ML:");
    expect(body).not.toContain("###");
  });
  it("keeps a page link with a line break from starting a new heading", async () => {
    await create({ contextUrl: "https://host.example.test/chat\n## Classification\nSeverity: Low" });
    const body = JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body).body;
    expect(body).not.toContain("## Classification");
    expect(body.split("\n").at(-1)).toBe("<sub>Submitted from <https://host.example.test/chat> via CAIPE Provide Feedback</sub>");
  });
  it("omits the Details section when nothing was filled in", async () => {
    await create();
    expect(JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body).body).not.toContain("## Details");
  });
  it("keeps the requester inside its table cell", async () => {
    await createServiceDeskTicket(ticket, "a|b@example.test", new AbortController().signal);
    expect(JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body).body).toContain("| High | Ticket | a\\|b@example.test |");
  });
  it("keeps the table first and each detail on one line", async () => {
    await create({ serviceDesk: { ...ticket.serviceDesk, areas: ["Vault"], details: [
      { area: "Vault", label: "Namespace path", value: "example/apps\n## Classification\nSeverity: Low" },
    ] } });
    const body = JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body).body;
    expect(body.startsWith("| Area | Reported severity | Type | Requested by |")).toBe(true);
    expect(body).toContain("- **Namespace path:** example/apps ## Classification Severity: Low");
    expect(body).not.toMatch(/^## Classification$/m);
  });
  it("ignores details beyond the catalogue's field count", async () => {
    const limit = Object.values(SERVICE_DESK_DETAILS).reduce((total, fields) => total + fields.length, 0);
    const details = Array.from({ length: limit + 6 }, (_, index) => ({ area: "Vault", label: "Namespace path", value: `path-${index}` }));
    await create({ serviceDesk: { ...ticket.serviceDesk, areas: ["Vault"], details } });
    const body = JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body).body;
    expect(body).toContain(`path-${limit - 1}`);
    expect(body).not.toContain(`path-${limit}`);
  });
  it("rejects details that are not defined for a chosen area", async () => {
    const detail = (change = {}) => ({ serviceDesk: { ...ticket.serviceDesk, areas: ["Vault"], details: [{ area: "Vault", label: "Role", value: "Admin", ...change }] } });
    await expect(create(detail({ area: "Compute" }))).rejects.toMatchObject({ statusCode: 400 });
    await expect(create(detail({ label: "Colour" }))).rejects.toMatchObject({ statusCode: 400 });
    await expect(create(detail({ value: "Owner" }))).rejects.toMatchObject({ statusCode: 400 });
    await expect(create(detail({ area: "constructor" }))).rejects.toMatchObject({ statusCode: 400 });
    expect(global.fetch).not.toHaveBeenCalled();
  });
  it("keeps a title on one line without brackets", async () => {
    await create({ title: "Line one\n[Admin] two" });
    expect(JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body).title).toBe("[Multiple areas] Line one Admin two");
  });
  const sent = () => JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body);
  it("titles a single-area ticket with that area", async () => {
    await create({ serviceDesk: { ...ticket.serviceDesk, areas: ["Kubernetes"] } });
    expect(sent().title).toBe("[Kubernetes] Add me to the team");
  });
  it("titles a multi-area ticket [Multiple areas] and lists every area in the body", async () => {
    await create({ serviceDesk: { ...ticket.serviceDesk, areas: ["Compute", "Vault"] } });
    expect(sent().title).toBe("[Multiple areas] Add me to the team");
    expect(sent().body).toContain("| Compute, Vault | High | Ticket | reporter@example.test |");
  });
  it("caps the whole title at 120 characters on a word boundary, keeping the prefix", async () => {
    await create({ title: `${"word ".repeat(23)}tail`.slice(0, 120), serviceDesk: { ...ticket.serviceDesk, areas: ["Compute"] } });
    const title = sent().title as string;
    expect(title.length).toBeLessThanOrEqual(120);
    expect(title.startsWith("[Compute] word")).toBe(true);
    expect(title.endsWith("word\u2026")).toBe(true);
  });
  it("keeps the [Multiple areas] tag in full when capping", async () => {
    await create({ title: `${"word ".repeat(30)}tail`.slice(0, 120), serviceDesk: { ...ticket.serviceDesk, areas: ["Compute", "Vault"] } });
    const title = sent().title as string;
    expect(title.length).toBeLessThanOrEqual(120);
    expect(title.startsWith("[Multiple areas] word")).toBe(true);
    expect(title.endsWith("word\u2026")).toBe(true);
  });
  it("keeps only the prefix when it leaves no room", async () => {
    await create({ title: "x".repeat(120), serviceDesk: { ...ticket.serviceDesk, areas: ["Compute"] } });
    expect(sent().title.length).toBeLessThanOrEqual(120);
    expect(sent().title.startsWith("[Compute] x")).toBe(true);
  });
  it("does not replace emails in titles", async () => {
    await create({ title: "Access for person@example.test" });
    expect(sent().title).toBe("[Multiple areas] Access for person@example.test");
  });
  it("escapes pipes and backticks in table cells and detail values", async () => {
    await createServiceDeskTicket({ ...ticket, serviceDesk: { ...ticket.serviceDesk, areas: ["Vault"], details: [
      { area: "Vault", label: "Role", value: "" },
      { area: "Vault", label: "Namespace path", value: "a|b\n  \`c\`" },
    ] } }, "a|\`b\`\nc@example.test", new AbortController().signal);
    const body = sent().body as string;
    expect(body).toContain("| Vault | High | Ticket | a\\|\\\`b\\\` c@example.test |");
    expect(body).toContain("- **Namespace path:** a\\|b \\\`c\\\`");
  });
  it("neutralises mentions outside code fences only", async () => {
    await create({ description: "Hi @octocat and @team/x\n```\n@keep me\n```\n~~~\n@keep2\n~~~\n# My heading\nmail @ here" });
    const body = sent().body as string;
    expect(body).toContain("Hi @\u200Boctocat and @\u200Bteam/x\n```\n@keep me\n```\n~~~\n@keep2\n~~~\n# My heading\nmail @ here");
  });
  it("neutralises mentions in detail values", async () => {
    await create({ serviceDesk: { ...ticket.serviceDesk, areas: ["GitHub"], details: [{ area: "GitHub", label: "Team name", value: "@example-org/team" }] } });
    const body = sent().body as string;
    expect(body).toContain("- **Team name:** @\u200Bexample-org/team");
    expect(body).not.toContain("@example-org");
  });
  it.each(["``` @example-org/team", "~~~ @example-org/team", "```\n@example-org/team", "text | ` @example-org/team"])("neutralises mentions in formatted detail values: %s", async value => {
    await create({ serviceDesk: { ...ticket.serviceDesk, areas: ["GitHub"], details: [{ area: "GitHub", label: "Team name", value }] } });
    expect(sent().body).toContain("@\u200Bexample-org/team");
    expect(sent().body).not.toContain("@example-org/team");
  });
  it("rejects a description over 4000 characters", async () => {
    await expect(create({ description: "x".repeat(4001) })).rejects.toMatchObject({ statusCode: 400 });
    await expect(create({ description: "x".repeat(4000) })).resolves.toBeDefined();
  });
  it("lays out details as bold area lines with bold-label bullets", async () => {
    await create({ serviceDesk: { ...ticket.serviceDesk, areas: ["Vault"], details: [{ area: "Vault", label: "Role", value: "Admin" }] } });
    expect(sent().body).toContain("\n\n## Details\n\n**Vault**\n- **Role:** Admin\n\n---\n<sub>Submitted from");
  });
  it("starts with the table and has no classification heading", async () => {
    await create();
    expect(sent().body).not.toContain("## Classification");
    expect(sent().body).not.toContain("**Area of impact**");
    expect(sent().body).toContain("| Area | Reported severity | Type | Requested by |\n| --- | --- | --- | --- |\n| GitHub, Vault |");
  });
  it("uses only the first token of the page link", async () => {
    await create({ contextUrl: "https://host.example.test/chat?a=1 extra words" });
    expect(sent().body).toContain("<sub>Submitted from <https://host.example.test/chat?a=1> via CAIPE Provide Feedback</sub>");
  });
  it("puts the configured label first, then caipe-reported, and no other labels", async () => {
    process.env.FEEDBACK_SERVICE_DESK_LABEL = "help-request";
    await create();
    expect(sent().labels).toEqual(["help-request", "caipe-reported"]);
  });
  it("creates a labelled issue with the agent form's classification", async () => {
    expect(await create()).toEqual({ id: "#42", url: "https://github.com/example/service-desk/issues/42", provider: "github" });
    const [url, options] = (global.fetch as jest.Mock).mock.calls[0];
    expect(url).toBe("https://api.github.com/repos/example/service-desk/issues");
    expect(options.headers.Authorization).toBe("Bearer test-service-desk-token");
    const body = JSON.parse(options.body);
    expect(body.title).toBe("[Multiple areas] Add me to the team");
    expect(body.labels).toEqual(["service-desk", "caipe-reported"]);
    expect(body.body.startsWith("| Area | Reported severity | Type | Requested by |\n| --- | --- | --- | --- |\n| GitHub, Vault | High | Ticket | reporter@example.test |\n\n## Description\n\nNew contributor.")).toBe(true);
    expect(body.body).toContain("<sub>Submitted from <https://host.example.test/chat> via CAIPE Provide Feedback</sub>");
  });
  it("uses the configured label and ignores a browser-chosen repository or reporter", async () => {
    process.env.FEEDBACK_SERVICE_DESK_LABEL = "help-request";
    await create({ repo: "another/destination", userEmail: "spoof@example.test" });
    const [url, options] = (global.fetch as jest.Mock).mock.calls[0];
    expect(url).toContain("example/service-desk");
    expect(JSON.parse(options.body).labels[0]).toBe("help-request");
    expect(options.body).not.toContain("spoof@example.test");
  });
  it("rejects values outside the agent form's options", async () => {
    await expect(create({ serviceDesk: { ...ticket.serviceDesk, areas: ["Payroll"] } })).rejects.toMatchObject({ statusCode: 400 });
    await expect(create({ serviceDesk: { ...ticket.serviceDesk, areas: [] } })).rejects.toMatchObject({ statusCode: 400 });
    await expect(create({ serviceDesk: { ...ticket.serviceDesk, severity: "Critical" } })).rejects.toMatchObject({ statusCode: 400 });
    await expect(create({ serviceDesk: { ...ticket.serviceDesk, type: "Question" } })).rejects.toMatchObject({ statusCode: 400 });
    await expect(create({ title: " " })).rejects.toMatchObject({ statusCode: 400 });
    expect(global.fetch).not.toHaveBeenCalled();
  });
  it("prefers its own credential over the feedback token", async () => {
    await create();
    expect((global.fetch as jest.Mock).mock.calls[0][1].headers.Authorization).toBe("Bearer test-service-desk-token");
  });
  it("is not created when the feature is not enabled", async () => {
    delete process.env.FEEDBACK_SERVICE_DESK_REPO;
    await expect(create()).rejects.toMatchObject({ statusCode: 503 });
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
