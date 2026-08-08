import { SecretService } from "@/lib/credentials/secret-service";

interface MemorySecretRefDoc extends Record<string, unknown> {
  id?: string;
  owner?: { type?: string; id?: string };
  sharedWithTeams?: string[];
}

class MemorySecretRefsCollection {
  docs: MemorySecretRefDoc[] = [];

  async insertOne(doc: MemorySecretRefDoc) {
    this.docs.push(doc);
    return { acknowledged: true };
  }

  find(query: Record<string, unknown>) {
    const docs = this.docs.filter((doc) =>
      Object.entries(query).every(([key, value]) => {
        if (key === "owner.type") return doc.owner?.type === value;
        if (key === "owner.id") return doc.owner?.id === value;
        if (key === "id" && value && typeof value === "object" && "$in" in value) {
          return (value.$in as string[]).includes(String(doc.id));
        }
        return doc[key] === value;
      }),
    );
    return {
      sort: () => ({
        toArray: async () => docs,
      }),
    };
  }

  async findOne(query: Record<string, unknown>) {
    return (
      this.docs.find((doc) =>
        Object.entries(query).every(([key, value]) => doc[key] === value),
      ) ?? null
    );
  }

  async updateOne(
    query: Record<string, unknown>,
    update: {
      $set?: Record<string, unknown>;
      $addToSet?: { sharedWithTeams?: string };
      $pull?: { sharedWithTeams?: string };
    },
  ) {
    const doc = await this.findOne(query);
    if (!doc) return { matchedCount: 0, modifiedCount: 0 };
    Object.assign(doc, update.$set ?? {});
    if (update.$addToSet?.sharedWithTeams) {
      doc.sharedWithTeams = [...new Set([...(doc.sharedWithTeams ?? []), update.$addToSet.sharedWithTeams])];
    }
    if (update.$pull?.sharedWithTeams) {
      doc.sharedWithTeams = (doc.sharedWithTeams ?? []).filter(
        (team: string) => team !== update.$pull.sharedWithTeams,
      );
    }
    return { matchedCount: 1, modifiedCount: 1 };
  }

  async deleteOne(query: Record<string, unknown>) {
    const before = this.docs.length;
    this.docs = this.docs.filter((doc) => doc.id !== query.id);
    return { deletedCount: before - this.docs.length };
  }
}

function createService(
  options: {
    resolveUsage?: ConstructorParameters<typeof SecretService>[0]["resolveUsage"];
    listReadableSecretIds?: ConstructorParameters<typeof SecretService>[0]["listReadableSecretIds"];
  } = {},
) {
  const refs = new MemorySecretRefsCollection();
  const payloadStore = {
    putSecret: jest.fn(async () => undefined),
    getSecret: jest.fn(async () => "github-token-value"),
    getMaskedPreview: jest.fn(async (secretRefId: string) =>
      secretRefId === "shared-secret" ? "jir_...alue" : "gith...alue",
    ),
    rotateSecret: jest.fn(async () => undefined),
    deleteSecret: jest.fn(async () => undefined),
  };
  const authorize = jest.fn(async () => undefined);
  const reconcileOwnerRelationships = jest.fn(async () => undefined);
  const reconcileShare = jest.fn(async () => undefined);
  const deleteShare = jest.fn(async () => undefined);
  const deleteAllRelationships = jest.fn(async () => undefined);

  return {
    refs,
    payloadStore,
    authorize,
    reconcileOwnerRelationships,
    reconcileShare,
    deleteShare,
    deleteAllRelationships,
    service: new SecretService({
      secretRefsCollection: refs,
      payloadStore,
      authorize,
      listReadableSecretIds: options.listReadableSecretIds,
      reconcileOwnerRelationships,
      reconcileShare,
      deleteShare,
      deleteAllRelationships,
      resolveUsage: options.resolveUsage,
      idGenerator: () => "secret-1",
      now: () => new Date("2026-05-21T00:00:00.000Z"),
    }),
  };
}

describe("SecretService", () => {
  it("idempotently bootstraps a stable secret id and repairs its team relationships", async () => {
    const {
      refs,
      payloadStore,
      reconcileOwnerRelationships,
      reconcileShare,
      service,
    } = createService();
    payloadStore.getSecret.mockRejectedValueOnce(new Error("payload missing"));

    const input = {
      id: "webex-pam-bot-token",
      owner: { type: "team" as const, id: "super-admins" },
      name: "Webex Pam bot token",
      type: "bearer_token" as const,
      plaintext: "pam-token-value",
      description: "Shared Webex bot identity",
      sharedWithTeams: ["platform-users", "platform-users"],
    };

    await expect(service.upsertBootstrapSecret(input)).resolves.toBe("created");
    expect(payloadStore.putSecret).toHaveBeenCalledWith({
      secretRefId: "webex-pam-bot-token",
      plaintext: "pam-token-value",
      maskedPreview: "pam-...alue",
    });
    expect(reconcileOwnerRelationships).toHaveBeenCalledWith({
      secretId: "webex-pam-bot-token",
      owner: { type: "team", id: "super-admins" },
      ownerSubject: null,
    });
    expect(reconcileShare).toHaveBeenCalledWith(
      "webex-pam-bot-token",
      "platform-users",
    );
    expect(refs.docs[0]).toMatchObject({
      id: "webex-pam-bot-token",
      owner: { type: "team", id: "super-admins" },
      createdBy: { type: "service_account", id: "credential-bootstrap" },
      sharedWithTeams: ["platform-users"],
    });

    payloadStore.getSecret.mockResolvedValueOnce("pam-token-value");
    await expect(service.upsertBootstrapSecret(input)).resolves.toBe("unchanged");
    expect(payloadStore.putSecret).toHaveBeenCalledTimes(1);
    expect(reconcileOwnerRelationships).toHaveBeenCalledTimes(2);
  });

  it("creates a secret ref and stores raw material plus masked preview only in the encrypted payload store", async () => {
    const { refs, payloadStore, reconcileOwnerRelationships, service } = createService();

    const result = await service.createSecret({
      session: { sub: "alice-sub", user: { email: "alice@example.test", name: "Alice Example" } },
      owner: { type: "user", id: "alice-sub" },
      name: "GitHub token",
      type: "bearer_token",
      plaintext: "github-token-value",
    });

    expect(result).toMatchObject({
      id: "secret-1",
      name: "GitHub token",
      maskedPreview: "gith...alue",
      createdBy: {
        type: "user",
        id: "alice-sub",
        email: "alice@example.test",
        name: "Alice Example",
      },
      storage: expect.objectContaining({
        metadataCollection: "credential_secret_refs",
        payloadCollection: "credential_encrypted_payloads",
        valuePreviewAvailable: true,
      }),
    });
    expect(payloadStore.putSecret).toHaveBeenCalledWith({
      secretRefId: "secret-1",
      plaintext: "github-token-value",
      maskedPreview: "gith...alue",
    });
    expect(reconcileOwnerRelationships).toHaveBeenCalledWith({
      secretId: "secret-1",
      owner: { type: "user", id: "alice-sub" },
      ownerSubject: "alice-sub",
    });
    expect(JSON.stringify(refs.docs)).not.toContain("github-token-value");
    expect(JSON.stringify(refs.docs)).not.toContain("gith...alue");
    expect(refs.docs[0]).not.toHaveProperty("maskedPreview");
  });

  it("cleans up the encrypted payload and relationships when secret creation fails", async () => {
    const {
      refs,
      payloadStore,
      reconcileOwnerRelationships,
      deleteAllRelationships,
      service,
    } = createService();
    reconcileOwnerRelationships.mockRejectedValueOnce(new Error("OpenFGA tuple write failed"));

    await expect(
      service.createSecret({
        session: { sub: "alice-sub" },
        owner: { type: "organization", id: "example-org" },
        name: "Example token",
        type: "bearer_token",
        plaintext: "example-token-value",
      }),
    ).rejects.toThrow("OpenFGA tuple write failed");

    expect(deleteAllRelationships).toHaveBeenCalledWith("secret-1");
    expect(payloadStore.deleteSecret).toHaveBeenCalledWith("secret-1");
    expect(refs.docs).toEqual([]);
  });

  it("adds usage metadata without loading plaintext", async () => {
    const resolveUsage = jest.fn(async () => [
      {
        type: "mcp_server" as const,
        id: "mcp-github",
        name: "GitHub MCP",
        location: "Agents > Tools",
        detail: "env: GITHUB_TOKEN",
      },
    ]);
    const { service } = createService({ resolveUsage });
    await service.createSecret({
      session: { sub: "alice-sub" },
      owner: { type: "user", id: "alice-sub" },
      name: "GitHub token",
      type: "bearer_token",
      plaintext: "github-token-value",
    });

    await expect(service.listAllSecretsForAdmin()).resolves.toEqual([
      expect.objectContaining({
        id: "secret-1",
        usage: [
          {
            type: "mcp_server",
            id: "mcp-github",
            name: "GitHub MCP",
            location: "Agents > Tools",
            detail: "env: GITHUB_TOKEN",
          },
        ],
      }),
    ]);
    expect(resolveUsage).toHaveBeenCalledWith(expect.objectContaining({ id: "secret-1" }));
  });

  it("lists only masked secret metadata for an owner", async () => {
    const { payloadStore, service } = createService();
    await service.createSecret({
      session: { sub: "alice-sub" },
      owner: { type: "user", id: "alice-sub" },
      name: "GitHub token",
      type: "bearer_token",
      plaintext: "github-token-value",
    });

    await expect(
      service.listSecrets({
        session: { sub: "alice-sub" },
        owner: { type: "user", id: "alice-sub" },
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        id: "secret-1",
        maskedPreview: "gith...alue",
      }),
    ]);
    expect(payloadStore.getMaskedPreview).toHaveBeenCalledWith("secret-1");
  });

  it("repairs legacy all-star previews without returning plaintext", async () => {
    const { payloadStore, service } = createService();
    await service.createSecret({
      session: { sub: "alice-sub" },
      owner: { type: "user", id: "alice-sub" },
      name: "ArgoCD token",
      type: "bearer_token",
      plaintext: "argocd",
    });
    payloadStore.getSecret.mockResolvedValueOnce("argocd");
    payloadStore.getMaskedPreview.mockResolvedValueOnce("******");

    await expect(
      service.listSecrets({
        session: { sub: "alice-sub" },
        owner: { type: "user", id: "alice-sub" },
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        id: "secret-1",
        maskedPreview: "a...d",
      }),
    ]);
    expect(payloadStore.putSecret).toHaveBeenLastCalledWith({
      secretRefId: "secret-1",
      plaintext: "argocd",
      maskedPreview: "a...d",
    });
    expect(JSON.stringify(await service.listSecrets({
      session: { sub: "alice-sub" },
      owner: { type: "user", id: "alice-sub" },
    }))).not.toContain("argocd");
  });

  it("keeps metadata lists available when a saved preview cannot be loaded", async () => {
    const { payloadStore, service } = createService();
    await service.createSecret({
      session: { sub: "alice-sub" },
      owner: { type: "user", id: "alice-sub" },
      name: "Jira token",
      type: "bearer_token",
      plaintext: "jira-token-value",
    });
    payloadStore.getMaskedPreview.mockRejectedValueOnce(new Error("preview store unavailable"));

    await expect(
      service.listSecrets({
        session: { sub: "alice-sub" },
        owner: { type: "user", id: "alice-sub" },
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        id: "secret-1",
        maskedPreview: "unavailable",
      }),
    ]);
    expect(JSON.stringify(await service.listAllSecretsForAdmin())).not.toContain("jira-token-value");
  });

  it("includes shared secrets discovered through the authorization graph", async () => {
    const listReadableSecretIds = jest.fn(async () => ["shared-secret"]);
    const { authorize, refs, service } = createService({ listReadableSecretIds });
    refs.docs.push(
      {
        id: "shared-secret",
        owner: { type: "user", id: "alice-sub" },
        createdBy: { type: "user", id: "alice-sub", email: "alice@example.test" },
        name: "Jira",
        type: "bearer_token",
        sharedWithTeams: ["eti_sre_admins_jenkins"],
        createdAt: new Date("2026-05-21T00:00:00.000Z"),
        updatedAt: new Date("2026-05-21T00:00:00.000Z"),
      },
    );

    await expect(
      service.listSecrets({
        session: { sub: "eti-sre-cicd.gen" },
        owner: { type: "user", id: "eti-sre-cicd.gen" },
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        id: "shared-secret",
        name: "Jira",
        maskedPreview: "jir_...alue",
      }),
    ]);
    expect(listReadableSecretIds).toHaveBeenCalledWith({ sub: "eti-sre-cicd.gen" });
    expect(authorize).toHaveBeenCalledWith(
      { sub: "eti-sre-cicd.gen" },
      { type: "secret_ref", id: "shared-secret", action: "read-metadata" },
    );
  });

  it("rotates, shares, revokes, and deletes without returning raw material", async () => {
    const { refs, payloadStore, reconcileShare, deleteShare, deleteAllRelationships, service } = createService();
    await service.createSecret({
      session: { sub: "alice-sub" },
      owner: { type: "user", id: "alice-sub" },
      name: "GitHub token",
      type: "bearer_token",
      plaintext: "github-token-value",
    });

    await service.rotateSecret({
      session: { sub: "alice-sub" },
      secretId: "secret-1",
      plaintext: "new-token-value",
    });
    await service.shareSecret({
      session: { sub: "alice-sub" },
      secretId: "secret-1",
      teamId: "platform-team",
    });
    await service.revokeSecretShare({
      session: { sub: "alice-sub" },
      secretId: "secret-1",
      teamId: "platform-team",
    });
    await service.deleteSecret({ session: { sub: "alice-sub" }, secretId: "secret-1" });

    expect(payloadStore.putSecret).toHaveBeenLastCalledWith({
      secretRefId: "secret-1",
      plaintext: "new-token-value",
      maskedPreview: "new-...alue",
    });
    expect(reconcileShare).toHaveBeenCalledWith("secret-1", "platform-team");
    expect(deleteShare).toHaveBeenCalledWith("secret-1", "platform-team");
    expect(deleteAllRelationships).toHaveBeenCalledWith("secret-1");
    expect(refs.docs).toEqual([]);
  });

  it("supports admin listing and metadata edits without exposing plaintext", async () => {
    const { payloadStore, refs, service } = createService();
    await service.createSecret({
      session: { sub: "alice-sub" },
      owner: { type: "user", id: "alice-sub" },
      name: "GitHub token",
      type: "bearer_token",
      plaintext: "github-token-value",
    });

    await expect(service.listAllSecretsForAdmin()).resolves.toEqual([
      expect.objectContaining({
        id: "secret-1",
        owner: { type: "user", id: "alice-sub" },
        maskedPreview: "gith...alue",
      }),
    ]);
    expect(payloadStore.getMaskedPreview).toHaveBeenCalledWith("secret-1");

    await service.updateSecretMetadataForAdmin({
      secretId: "secret-1",
      name: "Renamed token",
      description: "Used by GitHub MCP",
    });
    expect(refs.docs[0]).toMatchObject({
      name: "Renamed token",
      description: "Used by GitHub MCP",
    });
    expect(JSON.stringify(refs.docs)).not.toContain("github-token-value");
    expect(JSON.stringify(refs.docs)).not.toContain("gith...alue");
  });
});
