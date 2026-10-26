/**
 * @jest-environment node
 */

import { NextRequest } from "next/server";

const mockConfig = { workflowsEnabled: true };
const mockGetAuth = jest.fn();

jest.mock("@/lib/config", () => ({
  get config() {
    return mockConfig;
  },
}));

jest.mock("@/lib/api-middleware", () => ({
  getAuthFromBearerOrSession: (...args: unknown[]) => mockGetAuth(...args),
  handleApiError: (error: { message: string; statusCode?: number }) =>
    Response.json({ success: false, error: error.message }, { status: error.statusCode ?? 500 }),
}));

const mockConfigsGet = jest.fn();
const mockConfigsPost = jest.fn();
const mockConfigsPut = jest.fn();
const mockConfigsDelete = jest.fn();
const mockCheckAccessPost = jest.fn();
const mockRunsGet = jest.fn();
const mockRunsPost = jest.fn();
const mockRunGet = jest.fn();
const mockRunPatch = jest.fn();
const mockRunDelete = jest.fn();
const mockCancelPost = jest.fn();
const mockResumePost = jest.fn();

jest.mock("@/app/api/workflow-configs/route", () => ({
  GET: (...a: unknown[]) => mockConfigsGet(...a),
  POST: (...a: unknown[]) => mockConfigsPost(...a),
  PUT: (...a: unknown[]) => mockConfigsPut(...a),
  DELETE: (...a: unknown[]) => mockConfigsDelete(...a),
}));
jest.mock("@/app/api/workflow-configs/check-agent-access/route", () => ({
  POST: (...a: unknown[]) => mockCheckAccessPost(...a),
}));
jest.mock("@/app/api/workflow-runs/route", () => ({
  GET: (...a: unknown[]) => mockRunsGet(...a),
  POST: (...a: unknown[]) => mockRunsPost(...a),
  // The real module also exports PUT and DELETE; the MCP server must never call them.
  PUT: jest.fn(),
  DELETE: jest.fn(),
}));
jest.mock("@/app/api/workflow-runs/[id]/route", () => ({
  GET: (...a: unknown[]) => mockRunGet(...a),
  PATCH: (...a: unknown[]) => mockRunPatch(...a),
  DELETE: (...a: unknown[]) => mockRunDelete(...a),
}));
jest.mock("@/app/api/workflow-runs/[id]/cancel/route", () => ({ POST: (...a: unknown[]) => mockCancelPost(...a) }));
jest.mock("@/app/api/workflow-runs/[id]/resume/route", () => ({ POST: (...a: unknown[]) => mockResumePost(...a) }));

import { DELETE, GET, POST } from "../route";

const TOKEN = "Bearer caller-token";

function rpc(method: string, params?: unknown, id: number | null = 1) {
  return { jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }), ...(id === null ? {} : { id }) };
}

function post(body: unknown, headers: Record<string, string> = { authorization: TOKEN }) {
  return new NextRequest("http://bff.example.test/api/mcp/workflows", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
    body: JSON.stringify(body),
  });
}

async function call(tool: string, args: Record<string, unknown> = {}) {
  const response = await POST(post(rpc("tools/call", { name: tool, arguments: args })));
  expect(response.status).toBe(200);
  const { result } = await response.json();
  return result as { isError?: boolean; content: { type: string; text: string }[] };
}

const textOf = (result: { content: { text: string }[] }) => result.content[0].text;
const json = (value: unknown, status = 200) => Response.json(value, { status });
const sentRequest = (mock: jest.Mock): NextRequest => mock.mock.calls[0][0];

beforeEach(() => {
  jest.clearAllMocks();
  mockConfig.workflowsEnabled = true;
  mockGetAuth.mockResolvedValue({ user: { email: "alice@example.test" }, session: {} });
});

describe("endpoint gating", () => {
  it("is not found when Workflows is disabled", async () => {
    mockConfig.workflowsEnabled = false;
    const response = await POST(post(rpc("tools/list")));
    expect(response.status).toBe(404);
    expect(mockGetAuth).not.toHaveBeenCalled();
  });

  it("requires a bearer token and ignores session cookies", async () => {
    const response = await POST(post(rpc("tools/list"), { cookie: "next-auth.session-token=abc" }));
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe("Bearer");
    expect(mockGetAuth).not.toHaveBeenCalled();
  });

  it("rejects a token the API does not accept", async () => {
    mockGetAuth.mockRejectedValue(Object.assign(new Error("Invalid token"), { statusCode: 401 }));
    const response = await POST(post(rpc("tools/list")));
    expect(response.status).toBe(401);
  });

  it("is POST only", async () => {
    expect((await GET()).status).toBe(405);
    expect((await DELETE()).status).toBe(405);
  });
});

describe("protocol", () => {
  it("answers initialize", async () => {
    const response = await POST(
      post(rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } })),
    );
    expect(response.status).toBe(200);
    const { result } = await response.json();
    expect(result.serverInfo.name).toBe("caipe-workflows");
    expect(result.capabilities.tools).toBeDefined();
  });

  it("lists exactly the supported tools", async () => {
    const response = await POST(post(rpc("tools/list")));
    const { result } = await response.json();
    const tools: { name: string; annotations?: Record<string, boolean> }[] = result.tools;
    expect(tools.map((t) => t.name).sort()).toEqual([
      "cancel_workflow_run",
      "check_workflow_agent_access",
      "create_workflow",
      "delete_workflow",
      "delete_workflow_run",
      "get_workflow",
      "get_workflow_run",
      "list_workflow_runs",
      "list_workflows",
      "resume_workflow_run",
      "share_workflow_run",
      "start_workflow_run",
      "update_workflow",
    ]);
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    expect(byName.list_workflows.annotations?.readOnlyHint).toBe(true);
    expect(byName.delete_workflow.annotations?.destructiveHint).toBe(true);
    expect(byName.delete_workflow_run.annotations?.destructiveHint).toBe(true);
    expect(byName.cancel_workflow_run.annotations?.destructiveHint).toBe(true);
  });
});

describe("definitions", () => {
  it("lists workflows as the caller", async () => {
    mockConfigsGet.mockResolvedValue(json([{ _id: "w1", name: "Report" }]));
    const result = await call("list_workflows");
    expect(JSON.parse(textOf(result))).toEqual([{ _id: "w1", name: "Report" }]);
    const request = sentRequest(mockConfigsGet);
    expect(request.method).toBe("GET");
    expect(request.headers.get("authorization")).toBe(TOKEN);
    expect(new URL(request.url).pathname).toBe("/api/workflow-configs");
  });

  it("fetches one workflow by id", async () => {
    mockConfigsGet.mockResolvedValue(json({ _id: "w1", steps: [] }));
    await call("get_workflow", { workflow_id: "w1" });
    expect(new URL(sentRequest(mockConfigsGet).url).searchParams.get("id")).toBe("w1");
  });

  it("creates a workflow and unwraps the API envelope", async () => {
    mockConfigsPost.mockResolvedValue(json({ success: true, data: { id: "w2", message: "created" } }, 201));
    const result = await call("create_workflow", {
      name: "Daily report",
      steps: [{ display_text: "Gather", agent_id: "agent-a", prompt: "Gather data" }],
    });
    expect(JSON.parse(textOf(result))).toEqual({ id: "w2", message: "created" });
    const body = await sentRequest(mockConfigsPost).json();
    expect(body).toEqual({
      name: "Daily report",
      visibility: "private",
      steps: [{ type: "step", display_text: "Gather", agent_id: "agent-a", prompt: "Gather data", on_error: "abort" }],
    });
  });

  it("requires teams for team visibility without calling the API", async () => {
    const result = await call("create_workflow", {
      name: "Shared",
      visibility: "team",
      steps: [{ display_text: "A", agent_id: "agent-a", prompt: "p" }],
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/shared_with_teams/);
    expect(mockConfigsPost).not.toHaveBeenCalled();
  });

  it("rejects a retry step without retry settings", async () => {
    const result = await call("create_workflow", {
      name: "Flaky",
      steps: [{ display_text: "A", agent_id: "agent-a", prompt: "p", on_error: "retry" }],
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/retry/);
    expect(mockConfigsPost).not.toHaveBeenCalled();
  });

  it("updates only the fields passed", async () => {
    mockConfigsPut.mockResolvedValue(json({ success: true, data: { id: "w1", message: "updated" } }));
    await call("update_workflow", { workflow_id: "w1", name: "Renamed" });
    const request = sentRequest(mockConfigsPut);
    expect(new URL(request.url).searchParams.get("id")).toBe("w1");
    expect(await request.json()).toEqual({ name: "Renamed" });
  });

  it("refuses an update that changes nothing", async () => {
    const result = await call("update_workflow", { workflow_id: "w1" });
    expect(result.isError).toBe(true);
    expect(mockConfigsPut).not.toHaveBeenCalled();
  });

  it("deletes a workflow", async () => {
    mockConfigsDelete.mockResolvedValue(json({ success: true, data: { id: "w1", message: "deleted" } }));
    await call("delete_workflow", { workflow_id: "w1" });
    expect(new URL(sentRequest(mockConfigsDelete).url).searchParams.get("id")).toBe("w1");
    expect(sentRequest(mockConfigsDelete).method).toBe("DELETE");
  });

  it("checks agent access for the planned audience", async () => {
    mockCheckAccessPost.mockResolvedValue(json({ gaps: [] }));
    const result = await call("check_workflow_agent_access", {
      visibility: "team",
      shared_with_teams: ["platform"],
      steps: [{ display_text: "A", agent_id: "agent-a", prompt: "p" }],
    });
    expect(JSON.parse(textOf(result))).toEqual({ gaps: [] });
    const body = await sentRequest(mockCheckAccessPost).json();
    expect(body.visibility).toBe("team");
    expect(body.shared_with_teams).toEqual(["platform"]);
  });
});

describe("runs", () => {
  it("starts a run", async () => {
    mockRunsPost.mockResolvedValue(json({ run_id: "r1", status: "running" }, 201));
    const result = await call("start_workflow_run", { workflow_id: "w1", user_context: "Q3 numbers", trigger_info: { source: "ticket-1" } });
    expect(JSON.parse(textOf(result))).toEqual({ run_id: "r1", status: "running" });
    expect(await sentRequest(mockRunsPost).json()).toEqual({
      workflow_config_id: "w1",
      user_context: "Q3 numbers",
      trigger_info: { source: "ticket-1" },
    });
    expect(sentRequest(mockRunsPost).headers.get("authorization")).toBe(TOKEN);
  });

  it("lists runs for one workflow", async () => {
    mockRunsGet.mockResolvedValue(json([{ _id: "r1" }]));
    await call("list_workflow_runs", { workflow_id: "w1" });
    expect(new URL(sentRequest(mockRunsGet).url).searchParams.get("workflow_config_id")).toBe("w1");
  });

  it("omits the event log unless asked for", async () => {
    mockRunGet.mockResolvedValue(json({ _id: "r1", status: "completed", events: { 0: [{ type: "log" }] } }));
    const brief = JSON.parse(textOf(await call("get_workflow_run", { run_id: "r1" })));
    expect(brief).toEqual({ _id: "r1", status: "completed" });
    await expect(mockRunGet.mock.calls[0][1].params).resolves.toEqual({ id: "r1" });

    mockRunGet.mockClear();
    mockRunGet.mockResolvedValue(json({ _id: "r1", status: "completed", events: { 0: [{ type: "log" }] } }));
    const full = JSON.parse(textOf(await call("get_workflow_run", { run_id: "r1", include_events: true })));
    expect(full.events).toBeDefined();
  });

  it("cancels, resumes, shares and deletes a run by id", async () => {
    mockCancelPost.mockResolvedValue(json({ status: "cancelled" }));
    mockResumePost.mockResolvedValue(json({ status: "resumed" }));
    mockRunPatch.mockResolvedValue(json({ id: "r1", shared_with: "workspace" }));
    mockRunDelete.mockResolvedValue(json({ success: true, data: { id: "r1", message: "deleted" } }));

    await call("cancel_workflow_run", { run_id: "r1" });
    await call("resume_workflow_run", { run_id: "r1", step_index: 2, resume_data: { approve: true } });
    await call("share_workflow_run", { run_id: "r1", shared_with: "workspace" });
    await call("delete_workflow_run", { run_id: "r1" });

    await expect(mockCancelPost.mock.calls[0][1].params).resolves.toEqual({ id: "r1" });
    expect(await sentRequest(mockResumePost).json()).toEqual({ step_index: 2, resume_data: { approve: true } });
    expect(await sentRequest(mockRunPatch).json()).toEqual({ shared_with: "workspace" });
    expect(sentRequest(mockRunDelete).method).toBe("DELETE");
  });

  it("encodes run ids so they cannot change the path", async () => {
    mockRunGet.mockResolvedValue(json({ _id: "x" }));
    await call("get_workflow_run", { run_id: "../../admin" });
    expect(new URL(sentRequest(mockRunGet).url).pathname).toBe("/api/workflow-runs/..%2F..%2Fadmin");
  });
});

describe("errors", () => {
  it("reports an API failure as a tool error with its message", async () => {
    mockRunGet.mockResolvedValue(json({ success: false, error: "Run r9 not found" }, 404));
    const result = await call("get_workflow_run", { run_id: "r9" });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe("CAIPE API returned HTTP 404: Run r9 not found");
  });

  it("reports an authorization failure without exposing anything else", async () => {
    mockCancelPost.mockResolvedValue(json({ success: false, error: "Forbidden", code: "pdp_denied" }, 403));
    const result = await call("cancel_workflow_run", { run_id: "r1" });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe("CAIPE API returned HTTP 403: Forbidden");
  });

  it("hides unexpected internal errors", async () => {
    mockConfigsGet.mockRejectedValue(new Error("mongo://admin:secret@db unreachable"));
    jest.spyOn(console, "error").mockImplementation(() => undefined);
    const result = await call("list_workflows");
    expect(result.isError).toBe(true);
    expect(textOf(result)).not.toMatch(/secret|mongo/);
  });

  it("never reaches the unvalidated run-update route", async () => {
    const runsModule = jest.requireMock("@/app/api/workflow-runs/route");
    const response = await POST(post(rpc("tools/call", { name: "update_workflow_run", arguments: { run_id: "r1" } })));
    const body = await response.json();
    expect(body.error ?? body.result?.isError).toBeTruthy();
    expect(runsModule.PUT).not.toHaveBeenCalled();
  });
});
