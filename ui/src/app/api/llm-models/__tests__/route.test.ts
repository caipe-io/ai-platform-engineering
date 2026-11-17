/**
 * @jest-environment node
 */

import { NextRequest, NextResponse } from "next/server";

const mockGetAuthFromBearerOrSession = jest.fn();
const mockRequireRbacPermission = jest.fn();
const mockRequireResourcePermission = jest.fn();
const mockFilterResourcesByPermission = jest.fn();
const mockGetCollection = jest.fn();
const mockReconcileLlmModelRelationships = jest.fn();
const mockDeleteAllLlmModelRelationshipTuples = jest.fn();

jest.mock("@/lib/api-middleware", () => {
  class ApiError extends Error {
    statusCode: number;

    constructor(message: string, statusCode = 500) {
      super(message);
      this.statusCode = statusCode;
    }
  }

  return {
    ApiError,
    getAuthFromBearerOrSession: (...args: unknown[]) =>
      mockGetAuthFromBearerOrSession(...args),
    requireRbacPermission: (...args: unknown[]) =>
      mockRequireRbacPermission(...args),
    getPaginationParams: (request: NextRequest) => {
      const url = new URL(request.url);
      const page = Number(url.searchParams.get("page") ?? "1");
      const pageSize = Number(url.searchParams.get("page_size") ?? "20");
      return { page, pageSize, skip: (page - 1) * pageSize };
    },
    paginatedResponse: (
      items: unknown[],
      total: number,
      page: number,
      pageSize: number,
    ) =>
      NextResponse.json({
        items,
        pagination: { total, page, page_size: pageSize },
      }),
    successResponse: (data: unknown, status = 200) =>
      NextResponse.json({ success: true, data }, { status }),
    withErrorHandler:
      (handler: (request: NextRequest) => Promise<Response>) =>
      async (request: NextRequest) => {
        try {
          return await handler(request);
        } catch (error) {
          return NextResponse.json(
            {
              success: false,
              error: error instanceof Error ? error.message : "error",
            },
            {
              status:
                error && typeof error === "object" && "statusCode" in error
                  ? Number(error.statusCode)
                  : 500,
            },
          );
        }
      },
  };
});

jest.mock("@/lib/mongodb", () => ({
  getCollection: (...args: unknown[]) => mockGetCollection(...args),
}));

jest.mock("@/lib/rbac/resource-authz", () => ({
  filterResourcesByPermission: (...args: unknown[]) => mockFilterResourcesByPermission(...args),
  requireResourcePermission: (...args: unknown[]) => mockRequireResourcePermission(...args),
}));

jest.mock("@/lib/rbac/openfga-owned-resources-reconcile", () => ({
  deleteAllLlmModelRelationshipTuples: (...args: unknown[]) =>
    mockDeleteAllLlmModelRelationshipTuples(...args),
  reconcileLlmModelRelationships: (...args: unknown[]) =>
    mockReconcileLlmModelRelationships(...args),
}));

interface ModelDoc {
  _id: string;
  model_id: string;
  name: string;
  provider: string;
  description?: string;
  config_driven?: boolean;
  updated_at?: string;
}

function request(path: string, init: RequestInit = {}): NextRequest {
  return new NextRequest(new URL(path, "http://localhost:3000"), {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
}

function createCollection(rows: ModelDoc[]) {
  const sort = jest.fn(() => chain);
  const skip = jest.fn(() => chain);
  const limit = jest.fn(() => chain);
  const toArray = jest.fn(async () => rows);
  const chain = { sort, skip, limit, toArray };

  return {
    rows,
    countDocuments: jest.fn(async () => rows.length),
    find: jest.fn(() => chain),
    findOne: jest.fn(async (filter: { _id: string }) =>
      rows.find((row) => row._id === filter._id) ?? null,
    ),
    insertOne: jest.fn(async (doc: ModelDoc) => {
      rows.push(doc);
      return { acknowledged: true, insertedId: doc._id };
    }),
    updateOne: jest.fn(async (filter: { _id: string }, update: { $set: Partial<ModelDoc> }) => {
      const row = rows.find((candidate) => candidate._id === filter._id);
      if (row) Object.assign(row, update.$set);
      return { matchedCount: row ? 1 : 0, modifiedCount: row ? 1 : 0 };
    }),
    deleteOne: jest.fn(async (filter: { _id: string }) => {
      const index = rows.findIndex((row) => row._id === filter._id);
      if (index >= 0) rows.splice(index, 1);
      return { deletedCount: index >= 0 ? 1 : 0 };
    }),
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGetAuthFromBearerOrSession.mockResolvedValue({
    session: { sub: "admin-sub", user: { email: "admin@example.com" } },
    user: { email: "admin@example.com" },
  });
  mockRequireRbacPermission.mockResolvedValue(undefined);
  mockRequireResourcePermission.mockResolvedValue(undefined);
  mockFilterResourcesByPermission.mockImplementation(async (_session, items) => items);
  mockReconcileLlmModelRelationships.mockResolvedValue({ enabled: true, writes: 1, deletes: 0 });
  mockGetCollection.mockResolvedValue(createCollection([]));
});

describe("/api/llm-models", () => {
  it("lists models through OpenFGA llm_model read checks instead of admin_ui view", async () => {
    const collection = createCollection([
      {
        _id: "openai/gpt-4o",
        model_id: "openai/gpt-4o",
        name: "GPT-4o",
        provider: "openai",
      },
    ]);
    mockGetCollection.mockResolvedValue(collection);
    const { GET } = await import("../route");

    const response = await GET(request("/api/llm-models?page=2&page_size=5"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mockRequireRbacPermission).not.toHaveBeenCalled();
    expect(mockFilterResourcesByPermission).toHaveBeenCalledWith(
      { sub: "admin-sub", user: { email: "admin@example.com" } },
      collection.rows,
      { type: "llm_model", action: "read", id: expect.any(Function) },
    );
    expect(collection.find).toHaveBeenCalledWith({});
    expect(body.items).toHaveLength(0);
    expect(body.pagination).toEqual({ total: 1, page: 2, page_size: 5 });
  });

  it("returns one exact model for a deep link after its OpenFGA read check", async () => {
    const model = {
      _id: "openai/gpt-4o",
      model_id: "openai/gpt-4o",
      name: "GPT-4o",
      provider: "openai",
    };
    const collection = createCollection([model]);
    mockGetCollection.mockResolvedValue(collection);
    const { GET } = await import("../route");

    const response = await GET(request("/api/llm-models?id=openai%2Fgpt-4o"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(collection.findOne).toHaveBeenCalledWith({ _id: "openai/gpt-4o" });
    expect(mockFilterResourcesByPermission).toHaveBeenCalledWith(
      expect.objectContaining({ sub: "admin-sub" }),
      [model],
      { type: "llm_model", action: "read", id: expect.any(Function) },
    );
    expect(body).toEqual({ success: true, data: model });
  });

  it("creates user-managed models and ignores server-controlled fields", async () => {
    const collection = createCollection([]);
    mockGetCollection.mockResolvedValue(collection);
    const { POST } = await import("../route");

    const response = await POST(
      request("/api/llm-models", {
        method: "POST",
        body: JSON.stringify({
          model_id: "anthropic/claude-sonnet",
          name: "Claude Sonnet",
          provider: "anthropic",
          description: "Fast model",
          config_driven: true,
        }),
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(mockRequireRbacPermission).not.toHaveBeenCalled();
    expect(collection.insertOne).toHaveBeenCalledWith(
      expect.objectContaining({
        _id: "anthropic/claude-sonnet",
        model_id: "anthropic/claude-sonnet",
        name: "Claude Sonnet",
        provider: "anthropic",
        description: "Fast model",
        config_driven: false,
        owner_subject: "admin-sub",
      }),
    );
    expect(mockReconcileLlmModelRelationships).toHaveBeenCalledWith({
      modelId: "anthropic/claude-sonnet",
      ownerSubject: "admin-sub",
    });
    expect(mockRequireResourcePermission).not.toHaveBeenCalledWith(
      expect.anything(),
      { type: "admin_ui", id: expect.anything(), action: expect.anything() },
    );
    expect(body.data.config_driven).toBe(false);
  });

  it.each([
    [{ name: "No ID", provider: "openai" }, "model_id, name, and provider are required", 400],
    [
      { model_id: "-bad", name: "Bad", provider: "openai" },
      "model_id must start with alphanumeric",
      400,
    ],
  ])("rejects invalid create payloads", async (payload, message, status) => {
    const { POST } = await import("../route");

    const response = await POST(
      request("/api/llm-models", {
        method: "POST",
        body: JSON.stringify(payload),
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(status);
    expect(body.error).toContain(message);
  });

  it("rejects duplicate models", async () => {
    mockGetCollection.mockResolvedValue(
      createCollection([
        {
          _id: "openai/gpt-4o",
          model_id: "openai/gpt-4o",
          name: "GPT-4o",
          provider: "openai",
        },
      ]),
    );
    const { POST } = await import("../route");

    const response = await POST(
      request("/api/llm-models", {
        method: "POST",
        body: JSON.stringify({
          model_id: "openai/gpt-4o",
          name: "GPT-4o",
          provider: "openai",
        }),
      }),
    );

    expect(response.status).toBe(409);
  });

  it("updates only mutable fields on user-managed models", async () => {
    const collection = createCollection([
      {
        _id: "model-1",
        model_id: "model-1",
        name: "Old",
        provider: "openai",
        config_driven: false,
      },
    ]);
    mockGetCollection.mockResolvedValue(collection);
    const { PUT } = await import("../route");

    const response = await PUT(
      request("/api/llm-models?id=model-1", {
        method: "PUT",
        body: JSON.stringify({
          name: "New",
          provider: "anthropic",
          model_id: "attempted-change",
          config_driven: true,
        }),
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mockRequireResourcePermission).toHaveBeenCalledWith(
      { sub: "admin-sub", user: { email: "admin@example.com" } },
      { type: "llm_model", id: "model-1", action: "write" },
    );
    expect(collection.updateOne).toHaveBeenCalledWith(
      { _id: "model-1" },
      {
        $set: expect.objectContaining({
          name: "New",
          provider: "anthropic",
        }),
      },
    );
    expect(collection.updateOne.mock.calls[0][1].$set).not.toHaveProperty("model_id");
    expect(collection.updateOne.mock.calls[0][1].$set).not.toHaveProperty("config_driven");
    expect(body.data).toMatchObject({ name: "New", provider: "anthropic" });
  });

  it.each([
    ["/api/llm-models", {}, "id query parameter is required", 400],
    ["/api/llm-models?id=missing", { name: "New" }, "Model not found", 404],
  ])("rejects invalid update requests for %s", async (path, payload, message, status) => {
    const { PUT } = await import("../route");

    const response = await PUT(
      request(path, {
        method: "PUT",
        body: JSON.stringify(payload),
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(status);
    expect(body.error).toBe(message);
  });

  it("blocks edits and deletes for config-driven models", async () => {
    mockGetCollection.mockResolvedValue(
      createCollection([
        {
          _id: "seeded",
          model_id: "seeded",
          name: "Seeded",
          provider: "openai",
          config_driven: true,
        },
      ]),
    );
    const { PUT, DELETE } = await import("../route");

    const putResponse = await PUT(
      request("/api/llm-models?id=seeded", {
        method: "PUT",
        body: JSON.stringify({ name: "Blocked" }),
      }),
    );
    const deleteResponse = await DELETE(
      request("/api/llm-models?id=seeded", { method: "DELETE" }),
    );

    expect(putResponse.status).toBe(403);
    expect(deleteResponse.status).toBe(403);
  });

  it("deletes user-managed models", async () => {
    const collection = createCollection([
      {
        _id: "custom",
        model_id: "custom",
        name: "Custom",
        provider: "openai",
        config_driven: false,
      },
    ]);
    mockGetCollection.mockResolvedValue(collection);
    const { DELETE } = await import("../route");

    const response = await DELETE(
      request("/api/llm-models?id=custom", { method: "DELETE" }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mockRequireResourcePermission).toHaveBeenCalledWith(
      { sub: "admin-sub", user: { email: "admin@example.com" } },
      { type: "llm_model", id: "custom", action: "delete" },
    );
    expect(mockDeleteAllLlmModelRelationshipTuples).toHaveBeenCalledWith(
      "custom",
      { caller: { type: "user", id: "admin-sub" }, source: "llm_model_delete" },
    );
    expect(collection.deleteOne).toHaveBeenCalledWith({ _id: "custom" });
    expect(body).toEqual({ success: true, data: { deleted: true } });
  });
});


it("filters unpublished groups and denied models before slicing pages or counting", async () => {
  const rows = [
    { _id: "pending-1", model_id: "pending-1", name: "A", provider: "openai", connection_id: "pending" },
    { _id: "pending-2", model_id: "pending-2", name: "B", provider: "openai", connection_id: "pending" },
    { _id: "legacy", model_id: "legacy", name: "C", provider: "openai" },
    { _id: "ready", model_id: "ready", name: "D", provider: "openai", connection_id: "ready-group" },
    { _id: "denied", model_id: "denied", name: "E", provider: "openai" },
  ];
  const collection = createCollection(rows);
  mockGetCollection.mockImplementation(async (name: string) => name === "llm_models" ? collection : { find: () => ({ toArray: async () => [{ _id: "ready-group", state: "ready" }] }) });
  mockFilterResourcesByPermission.mockImplementation(async (_session, models) => models.filter((model: { _id: string }) => model._id !== "denied"));
  const { GET } = await import("../route");
  const first = await (await GET(request("/api/llm-models?page=1&page_size=1"))).json();
  const second = await (await GET(request("/api/llm-models?page=2&page_size=1"))).json();
  expect(first.items.map((item: { _id: string }) => item._id)).toEqual(["legacy"]);
  expect(second.items.map((item: { _id: string }) => item._id)).toEqual(["ready"]);
  expect(first.pagination.total).toBe(2);
  expect(second.pagination.total).toBe(2);
});
