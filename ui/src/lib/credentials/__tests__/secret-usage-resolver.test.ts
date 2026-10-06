/** @jest-environment node */

import { createSecretUsageResolver } from "../secret-service-factory";
import type { SecretRefDocument } from "../secret-service";

const collections = new Map<string, unknown[]>();

jest.mock("@/lib/mongodb", () => ({
  getCollection: jest.fn(async (name: string) => ({
    find: () => ({ toArray: async () => collections.get(name) ?? [] }),
  })),
}));

function secret(id: string): SecretRefDocument {
  return {
    id,
    owner: { type: "user", id: "alice-sub" },
    name: id,
    type: "bearer_token",
    sharedWithTeams: [],
    createdAt: new Date(),
    updatedAt: new Date(),
    rotatedAt: new Date(),
  } as unknown as SecretRefDocument;
}

beforeEach(() => {
  collections.clear();
});

describe("createSecretUsageResolver", () => {
  it("reports an ingestion source that references the secret", async () => {
    collections.set("rag_ingestion_sources", [
      {
        source_id: "web-docs-site",
        name: "Docs site",
        settings: {
          auth_headers: [
            { header_name: "Authorization", secret_ref: "docs-site-token" },
          ],
        },
      },
    ]);

    await expect(createSecretUsageResolver()(secret("docs-site-token"))).resolves.toEqual([
      {
        type: "ingestion_source",
        id: "web-docs-site",
        name: "Docs site",
        location: "Knowledge Bases > Ingest",
        detail: "Authorization",
      },
    ]);
  });

  it("ignores an ingestion source that references a different secret", async () => {
    collections.set("rag_ingestion_sources", [
      {
        source_id: "web-docs-site",
        name: "Docs site",
        settings: {
          auth_headers: [{ header_name: "Authorization", secret_ref: "other-token" }],
        },
      },
    ]);

    await expect(
      createSecretUsageResolver()(secret("docs-site-token")),
    ).resolves.toEqual([]);
  });

  it("reports both an MCP server and an ingestion source for the same secret", async () => {
    collections.set("mcp_servers", [
      {
        _id: "mcp-docs",
        name: "Docs MCP",
        credential_sources: [
          { kind: "secret_ref", target: "header", name: "Authorization", secret_ref: "docs-site-token" },
        ],
      },
    ]);
    collections.set("rag_ingestion_sources", [
      {
        source_id: "web-docs-site",
        settings: {
          auth_headers: [{ header_name: "X-Api-Key", secret_ref: "docs-site-token" }],
        },
      },
    ]);

    const usage = await createSecretUsageResolver()(secret("docs-site-token"));
    expect(usage.map((entry) => entry.type)).toEqual(["mcp_server", "ingestion_source"]);
    // Falls back to the source id when the source has no display name.
    expect(usage[1].name).toBe("web-docs-site");
  });

  it("reports nothing when no service references the secret", async () => {
    await expect(
      createSecretUsageResolver()(secret("docs-site-token")),
    ).resolves.toEqual([]);
  });
});
