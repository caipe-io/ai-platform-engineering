import {
  authorizeDraft,
  createModelConnection,
  modelRegistryId,
  parseConnectionDraft,
  publishedModels,
  resolveModelPlan,
  validateModelEndpoint,
} from "../model-connections";
import { getCollection } from "@/lib/mongodb";
import { requireResourcePermission } from "@/lib/rbac/resource-authz";
import { getCredentialSecretService } from "@/lib/credentials/secret-service-factory";
import { getCredentialRetrievalService } from "@/lib/credentials/retrieval-service-factory";

jest.mock("@/lib/mongodb", () => ({ getCollection: jest.fn() }));
jest.mock("@/lib/rbac/resource-authz", () => ({
  requireResourcePermission: jest.fn(),
  filterResourcesByPermission: jest.fn(),
}));
jest.mock("@/lib/rbac/openfga-owned-resources-reconcile", () => ({
  reconcileLlmModelRelationships: jest.fn(),
  deleteAllLlmModelRelationshipTuples: jest.fn(),
}));
jest.mock("@/lib/feature-flags/credentials", () => ({
  getCredentialFeatureConfig: () => ({ enabled: true }),
}));
jest.mock("@/lib/credentials/secret-service-factory", () => ({
  getCredentialSecretService: jest.fn(),
}));
jest.mock("@/lib/credentials/retrieval-service-factory", () => ({
  getCredentialRetrievalService: jest.fn(),
}));
const actor = {
  session: { sub: "test-subject" },
  email: "test-user@example.com",
};
const headers = new Headers({
  authorization: "Bearer example",
  "x-caipe-credential-caller": "dynamic_agent",
  "x-caipe-credential-audience": "caipe-credential-service",
});
const draft = {
  provider: "openai-compatible",
  auth_mode: "secrets",
  fields: { endpoint: "endpoint-ref", api_key: "key-ref" },
};
let modelRows: Record<string, unknown>[];
let connectionRows: Record<string, unknown>[];
const secretService = {
  getSecretMetadata: jest.fn(),
  getSecretRevisionForUse: jest.fn(),
  createSecret: jest.fn(),
  deleteSecret: jest.fn(),
};
const retrieval = { retrieve: jest.fn() };
let failInsert: boolean;
function matches(
  row: Record<string, unknown>,
  filter: Record<string, unknown>,
) {
  return Object.entries(filter).every(([key, value]) =>
    typeof value === "object" && value && "$in" in value
      ? (value.$in as unknown[]).includes(row[key])
      : row[key] === value,
  );
}
function collection(rows: Record<string, unknown>[]) {
  return {
    findOne: jest.fn(
      async (filter) => rows.find((row) => matches(row, filter)) ?? null,
    ),
    find: jest.fn((filter) => ({
      toArray: async () => rows.filter((row) => matches(row, filter)),
    })),
    insertOne: jest.fn(async (row) => {
      if (rows === modelRows && failInsert)
        throw new Error("sensitive upstream error");
      rows.push({ ...row });
    }),
    updateOne: jest.fn(async (filter, update) => {
      const row = rows.find((row) => matches(row, filter));
      if (row) Object.assign(row, update.$set);
      return { matchedCount: row ? 1 : 0 };
    }),
    deleteOne: jest.fn(async (filter) => {
      const index = rows.findIndex((row) => matches(row, filter));
      if (index >= 0) rows.splice(index, 1);
    }),
    deleteMany: jest.fn(async (filter) => {
      for (let i = rows.length - 1; i >= 0; i--)
        if (matches(rows[i], filter)) rows.splice(i, 1);
    }),
  };
}
beforeEach(() => {
  jest.resetAllMocks();
  modelRows = [];
  connectionRows = [];
  failInsert = false;
  (getCollection as jest.Mock).mockImplementation(async (name) =>
    collection(name === "llm_models" ? modelRows : connectionRows),
  );
  (getCredentialSecretService as jest.Mock).mockResolvedValue(secretService);
  (getCredentialRetrievalService as jest.Mock).mockResolvedValue(retrieval);
  secretService.getSecretMetadata.mockImplementation(async ({ secretId }) => ({
    id: secretId,
    type: secretId === "key-ref" ? "api_key" : "custom",
  }));
  secretService.getSecretRevisionForUse.mockResolvedValue("revision-1");
  secretService.createSecret.mockResolvedValue({ id: "new-secret" });
  retrieval.retrieve.mockImplementation(async ({ body }) => ({
    credential:
      body.secret_ref === "key-ref"
        ? "example-private-key"
        : "https://example.test/v1/",
  }));
});
it("normalizes root and versioned URLs without guessing paths or accepting embedded credentials", () => {
  expect(validateModelEndpoint("https://example.test/v1/")).toBe(
    "https://example.test/v1",
  );
  expect(validateModelEndpoint("https://example.test/")).toBe(
    "https://example.test",
  );
  for (const endpoint of [
    "ftp://example.test",
    "https://user:pass@example.test",
    "https://example.test?key=hidden",
  ])
    expect(() => validateModelEndpoint(endpoint)).toThrow();
});
it("requires explicit endpoint, Azure configuration, and complete static Bedrock identity", () => {
  expect(() =>
    parseConnectionDraft({ ...draft, fields: { api_key: "key-ref" } }),
  ).toThrow(/Endpoint/);
  expect(() =>
    parseConnectionDraft({ ...draft, provider: "azure-openai" }),
  ).toThrow(/api version/);
  expect(() =>
    parseConnectionDraft({
      ...draft,
      provider: "aws-bedrock",
      fields: { access_key_id: "id" },
    }),
  ).toThrow(/secret access key/);
  expect(
    parseConnectionDraft({ provider: "gcp-vertexai", auth_mode: "deployment" })
      .fields,
  ).toEqual({});
});
it("requires manage authority to pair a saved key with a new endpoint", async () => {
  (requireResourcePermission as jest.Mock).mockImplementation(
    async (_session, permission) => {
      if (permission.type === "secret_ref") throw new Error("denied");
    },
  );
  await expect(
    authorizeDraft(actor, parseConnectionDraft(draft)),
  ).rejects.toThrow("denied");
});
it("creates distinct models for the same upstream ID on different connections and saves references only", async () => {
  const first = await createModelConnection(actor, {
    ...draft,
    name: "Primary",
    models: ["example-model"],
  });
  const second = await createModelConnection(actor, {
    ...draft,
    name: "Secondary",
    models: ["example-model"],
  });
  expect(first.models[0]._id).not.toBe(second.models[0]._id);
  expect(first.models[0].upstream_model_id).toBe("example-model");
  expect(connectionRows.every((row) => row.state === "ready")).toBe(true);
  expect(JSON.stringify(connectionRows)).not.toContain("example-private-key");
  expect(retrieval.retrieve).not.toHaveBeenCalled();
});
it("rolls back newly created resources and preserves reused secrets on publication failure", async () => {
  failInsert = true;
  await expect(
    createModelConnection(actor, {
      ...draft,
      values: { endpoint: "https://example.test/v1" },
      fields: { api_key: "key-ref" },
      name: "Primary",
      models: ["example-model"],
    }),
  ).rejects.toThrow(/could not be created/);
  expect(secretService.deleteSecret).toHaveBeenCalledWith({
    session: actor.session,
    secretId: "new-secret",
  });
  expect(secretService.deleteSecret).not.toHaveBeenCalledWith(
    expect.objectContaining({ secretId: "key-ref" }),
  );
  expect(modelRows).toHaveLength(0);
  expect(connectionRows).toHaveLength(0);
});
it("replays a completed operation without creating duplicate models or secrets", async () => {
  const input = {
    ...draft,
    name: "Primary",
    models: ["example-model"],
    operation_id: "00000000-0000-4000-8000-000000000001",
  };
  await createModelConnection(actor, input);
  await createModelConnection(actor, input);
  expect(connectionRows).toHaveLength(1);
  expect(modelRows).toHaveLength(1);
});
it("publishes only ready model groups", async () => {
  connectionRows.push(
    { _id: "ready", state: "ready" },
    { _id: "pending", state: "pending" },
  );
  const models = [
    { _id: "legacy" },
    { _id: "a", connection_id: "ready" },
    { _id: "b", connection_id: "pending" },
  ];
  expect(await publishedModels(models as never)).toEqual(models.slice(0, 2));
});
async function registered() {
  const result = await createModelConnection(actor, {
    ...draft,
    name: "Primary",
    models: ["example-model"],
  });
  return result.models[0]._id;
}
it("resolves exactly the registered endpoint/key/model tuple and detects rotation without decrypting on cache checks", async () => {
  const id = await registered();
  const plan = await resolveModelPlan(actor, headers, { model_id: id });
  expect(plan.parameters).toEqual({
    base_url: "https://example.test/v1",
    api_key: "example-private-key",
  });
  expect(plan.model_id).toBe("example-model");
  retrieval.retrieve.mockClear();
  secretService.getSecretRevisionForUse.mockResolvedValue("revision-2");
  const metadata = await resolveModelPlan(actor, headers, {
    model_id: id,
    metadata_only: true,
  });
  expect(metadata.parameters).toEqual({});
  expect(metadata.revision).not.toBe(plan.revision);
  expect(retrieval.retrieve).not.toHaveBeenCalled();
  secretService.getSecretRevisionForUse.mockRejectedValue(new Error("revoked"));
  await expect(
    resolveModelPlan(actor, headers, { model_id: id, metadata_only: true }),
  ).rejects.toThrow("revoked");
});
it("rejects browser retrieval before decrypting any credential", async () => {
  const browserHeaders = new Headers(headers);
  browserHeaders.set("origin", "https://example.test");
  await expect(
    resolveModelPlan(actor, browserHeaders, { model_id: "example-model" }),
  ).rejects.toThrow(/Browser/);
  expect(retrieval.retrieve).not.toHaveBeenCalled();
});
it("retains deployment defaults for legacy records", async () => {
  modelRows.push({
    _id: "legacy",
    model_id: "example-model",
    provider: "openai",
    updated_at: "first",
  });
  expect(
    (await resolveModelPlan(actor, headers, { model_id: "legacy" })).parameters,
  ).toEqual({});
});
it("uses stable safe registry IDs for model IDs containing slashes", () => {
  expect(modelRegistryId("connection", "example/model")).toMatch(
    /^connection-[a-f0-9]{16}$/,
  );
});
it.each([
  [
    "anthropic-claude",
    { api_key: "key-ref" },
    { anthropic_api_key: "example-private-key" },
  ],
  [
    "azure-openai",
    {
      api_key: "key-ref",
      endpoint: "endpoint-ref",
      api_version: "version-ref",
    },
    {
      api_key: "example-private-key",
      azure_endpoint: "https://example.test/v1",
      api_version: "2026-01-01",
    },
  ],
  [
    "google-gemini",
    { api_key: "key-ref" },
    { google_api_key: "example-private-key" },
  ],
  ["groq", { api_key: "key-ref" }, { groq_api_key: "example-private-key" }],
  [
    "aws-bedrock",
    {
      access_key_id: "id-ref",
      secret_access_key: "key-ref",
      session_token: "token-ref",
      region: "region-ref",
    },
    {
      aws_access_key_id: "example-access",
      aws_secret_access_key: "example-private-key",
      aws_session_token: "example-session",
      region_name: "us-east-1",
    },
  ],
])(
  "maps %s connection fields to native provider options",
  async (provider, fields, expected) => {
    const values: Record<string, string> = {
      "key-ref": "example-private-key",
      "endpoint-ref": "https://example.test/v1",
      "version-ref": "2026-01-01",
      "id-ref": "example-access",
      "token-ref": "example-session",
      "region-ref": "us-east-1",
    };
    secretService.getSecretMetadata.mockImplementation(
      async ({ secretId }) => ({
        id: secretId,
        type:
          provider === "aws-bedrock"
            ? "custom"
            : secretId === "key-ref"
              ? "api_key"
              : "custom",
      }),
    );
    retrieval.retrieve.mockImplementation(async ({ body }) => ({
      credential: values[body.secret_ref],
    }));
    const created = await createModelConnection(actor, {
      provider,
      auth_mode: "secrets",
      fields,
      name: "Primary",
      models: ["example-model"],
    });
    expect(
      (
        await resolveModelPlan(actor, headers, {
          model_id: created.models[0]._id,
        })
      ).parameters,
    ).toEqual(expected);
  },
);
