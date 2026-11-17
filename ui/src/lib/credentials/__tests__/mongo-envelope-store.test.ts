import {
  createAwsKmsKeyWrapper,
  createDevLocalKeyWrapper,
  createLocalCmkKeyWrapper,
} from "@/lib/credentials/key-wrapper";
import { MongoEnvelopeCredentialStore } from "@/lib/credentials/mongo-envelope-store";

const textEncoder = new TextEncoder();

class MemoryPayloadCollection {
  readonly docs = new Map<string, Record<string, unknown>>();

  async findOne(query: { secretRefId: string }): Promise<Record<string, unknown> | null> {
    return this.docs.get(query.secretRefId) ?? null;
  }

  async updateOne(
    query: { secretRefId: string },
    update: { $set: Record<string, unknown>; $setOnInsert?: Record<string, unknown> },
    options: { upsert: boolean },
  ): Promise<{ upsertedCount: number; modifiedCount: number }> {
    if (!options.upsert && !this.docs.has(query.secretRefId)) {
      return { upsertedCount: 0, modifiedCount: 0 };
    }

    const existing = this.docs.get(query.secretRefId);
    this.docs.set(query.secretRefId, {
      ...(existing ?? update.$setOnInsert ?? {}),
      ...update.$set,
    });
    return { upsertedCount: existing ? 0 : 1, modifiedCount: existing ? 1 : 0 };
  }
}

describe("credential key wrappers", () => {
  it("wraps and unwraps a data key with the local-cmk wrapper outside production", async () => {
    const wrapper = createLocalCmkKeyWrapper({
      cmkId: "alias/caipe-local-credentials",
      nodeEnv: "test",
    });
    const wrapped = await wrapper.wrapDataKey(textEncoder.encode("data-key"));

    await expect(wrapper.unwrapDataKey(wrapped.encryptedDataKey)).resolves.toEqual(
      textEncoder.encode("data-key"),
    );
    expect(wrapped).toMatchObject({
      keyProvider: "local-cmk",
      cmkId: "alias/caipe-local-credentials",
    });
  });

  it("rejects local-cmk key wrapping in production mode", () => {
    expect(() =>
      createLocalCmkKeyWrapper({
        cmkId: "alias/caipe-local-credentials",
        nodeEnv: "production",
      }),
    ).toThrow("local-cmk key wrapping is not allowed in production");
  });

  it("wraps and unwraps a data key with the dev-local wrapper outside production", async () => {
    const wrapper = createDevLocalKeyWrapper({
      masterKey: "local-cmk-material-for-tests",
      nodeEnv: "test",
    });
    const wrapped = await wrapper.wrapDataKey(textEncoder.encode("data-key"));

    await expect(wrapper.unwrapDataKey(wrapped.encryptedDataKey)).resolves.toEqual(
      textEncoder.encode("data-key"),
    );
    expect(wrapped.keyProvider).toBe("dev-local");
  });

  it("rejects dev-local key wrapping in production mode", () => {
    expect(() =>
      createDevLocalKeyWrapper({
        masterKey: "local-cmk-material-for-tests",
        nodeEnv: "production",
      }),
    ).toThrow("dev-local key wrapping is not allowed in production");
  });

  describe("local prod-parity escape hatch (dev-only)", () => {
    const ENV = "CREDENTIAL_ALLOW_INSECURE_LOCAL_KEY_WRAP";
    let warnSpy: jest.SpyInstance;
    let previous: string | undefined;

    beforeEach(() => {
      previous = process.env[ENV];
      delete process.env[ENV];
      warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    });

    afterEach(() => {
      if (previous === undefined) {
        delete process.env[ENV];
      } else {
        process.env[ENV] = previous;
      }
      warnSpy.mockRestore();
    });

    it("still rejects local-cmk in production when the opt-in is absent", () => {
      expect(() =>
        createLocalCmkKeyWrapper({
          cmkId: "alias/caipe-local-credentials",
          nodeEnv: "production",
        }),
      ).toThrow("local-cmk key wrapping is not allowed in production");
    });

    it("still rejects local-cmk in production when the opt-in is set to a non-true value", () => {
      process.env[ENV] = "false";
      expect(() =>
        createLocalCmkKeyWrapper({
          cmkId: "alias/caipe-local-credentials",
          nodeEnv: "production",
        }),
      ).toThrow("local-cmk key wrapping is not allowed in production");
    });

    it("allows local-cmk in production via the env opt-in and warns loudly", async () => {
      process.env[ENV] = "true";
      const wrapper = createLocalCmkKeyWrapper({
        cmkId: "alias/caipe-local-credentials",
        nodeEnv: "production",
      });
      const wrapped = await wrapper.wrapDataKey(textEncoder.encode("data-key"));
      await expect(wrapper.unwrapDataKey(wrapped.encryptedDataKey)).resolves.toEqual(
        textEncoder.encode("data-key"),
      );
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("SECURITY WARNING"),
      );
    });

    it("allows dev-local in production via the explicit option override", async () => {
      const wrapper = createDevLocalKeyWrapper({
        masterKey: "local-cmk-material-for-tests",
        nodeEnv: "production",
        allowInsecureProductionKeyWrap: true,
      });
      const wrapped = await wrapper.wrapDataKey(textEncoder.encode("data-key"));
      await expect(wrapper.unwrapDataKey(wrapped.encryptedDataKey)).resolves.toEqual(
        textEncoder.encode("data-key"),
      );
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("SECURITY WARNING"));
    });

    it("option override of false beats a truthy env and still rejects", () => {
      process.env[ENV] = "true";
      expect(() =>
        createDevLocalKeyWrapper({
          masterKey: "local-cmk-material-for-tests",
          nodeEnv: "production",
          allowInsecureProductionKeyWrap: false,
        }),
      ).toThrow("dev-local key wrapping is not allowed in production");
    });
  });

  it("wraps and unwraps data keys with AWS KMS command responses", async () => {
    const plaintextKey = textEncoder.encode("kms-data-key-32-byte-material!!");
    const encryptedKey = textEncoder.encode("kms-wrapped-key");
    const sentCommands: string[] = [];
    const client = {
      async send(command: { constructor: { name: string } }) {
        sentCommands.push(command.constructor.name);
        if (command.constructor.name === "GenerateDataKeyCommand") {
          return { Plaintext: plaintextKey, CiphertextBlob: encryptedKey };
        }
        return { Plaintext: plaintextKey };
      },
    };
    const wrapper = createAwsKmsKeyWrapper({
      client,
      cmkId: "alias/caipe-local-credentials",
    });

    const generated = await wrapper.generateDataKey({
      secretRefId: "secret-1",
      purpose: "credential-secret",
    });
    const unwrapped = await wrapper.unwrapDataKey(generated.encryptedDataKey, {
      secretRefId: "secret-1",
      purpose: "credential-secret",
    });

    expect(generated).toMatchObject({
      keyProvider: "aws-kms",
      cmkId: "alias/caipe-local-credentials",
      encryptedDataKey: Buffer.from(encryptedKey).toString("base64"),
    });
    expect(unwrapped).toEqual(plaintextKey);
    expect(sentCommands).toEqual(["GenerateDataKeyCommand", "DecryptCommand"]);
  });

  it("translates AWS KMS access denial and outage failures into credential errors", async () => {
    const accessDeniedClient = {
      async send() {
        const error = new Error("denied");
        error.name = "AccessDeniedException";
        throw error;
      },
    };
    const unavailableClient = {
      async send() {
        const error = new Error("unavailable");
        error.name = "ServiceUnavailableException";
        throw error;
      },
    };

    await expect(
      createAwsKmsKeyWrapper({
        client: accessDeniedClient,
        cmkId: "alias/caipe-local-credentials",
      }).generateDataKey({ secretRefId: "secret-1", purpose: "credential-secret" }),
    ).rejects.toMatchObject({ reasonCode: "kms_access_denied", status: 403 });

    await expect(
      createAwsKmsKeyWrapper({
        client: unavailableClient,
        cmkId: "alias/caipe-local-credentials",
      }).unwrapDataKey("wrapped", { secretRefId: "secret-1", purpose: "credential-secret" }),
    ).rejects.toMatchObject({ reasonCode: "kms_unavailable", status: 503 });
  });
});

describe("MongoEnvelopeCredentialStore", () => {
  it("encrypts, decrypts, and rotates credential payloads without storing plaintext", async () => {
    const payloadCollection = new MemoryPayloadCollection();
    const store = new MongoEnvelopeCredentialStore({
      payloadCollection,
      keyWrapper: createDevLocalKeyWrapper({
        masterKey: "local-cmk-material-for-tests",
        nodeEnv: "test",
      }),
    });

    await store.putSecret({
      secretRefId: "secret-1",
      plaintext: "github-token-value",
      maskedPreview: "gith...alue",
    });
    const firstPayload = payloadCollection.docs.get("secret-1");
    expect(JSON.stringify(firstPayload)).not.toContain("github-token-value");
    expect(JSON.stringify(firstPayload)).not.toContain("gith...alue");
    expect(firstPayload?.maskedPreviewCiphertext).toEqual(expect.any(String));
    await expect(store.getSecret("secret-1")).resolves.toBe("github-token-value");
    await expect(store.getMaskedPreview("secret-1")).resolves.toBe("gith...alue");

    const createdAt = firstPayload?.createdAt;
    await store.rotateSecret("secret-1");
    const rotatedPayload = payloadCollection.docs.get("secret-1");

    expect(rotatedPayload?.createdAt).toEqual(createdAt);
    expect(rotatedPayload?.ciphertext).not.toEqual(firstPayload?.ciphertext);
    expect(rotatedPayload?.maskedPreviewCiphertext).not.toEqual(firstPayload?.maskedPreviewCiphertext);
    expect(rotatedPayload?.encryptedDek).not.toEqual(firstPayload?.encryptedDek);
    await expect(store.getSecret("secret-1")).resolves.toBe("github-token-value");
    await expect(store.getMaskedPreview("secret-1")).resolves.toBe("gith...alue");
  });
});


it("changes the runtime revision after a payload rotation even when metadata acknowledgement fails", async () => {
  const { SecretService } = await import("../secret-service");
  const payloadCollection = new MemoryPayloadCollection();
  const store = new MongoEnvelopeCredentialStore({ payloadCollection, keyWrapper: createDevLocalKeyWrapper({ masterKey: "example-test-wrapping-key", nodeEnv: "test" }) });
  let reference: import("../secret-service").SecretRefDocument | null = null;
  const refs = {
    insertOne: async (doc: import("../secret-service").SecretRefDocument) => { reference = doc; },
    findOne: async () => reference,
    find: () => ({ sort: () => ({ toArray: async () => reference ? [reference] : [] }) }),
    updateOne: jest.fn(async () => { throw new Error("metadata unavailable"); }),
    deleteOne: async () => ({ deletedCount: 0 }),
  };
  const service = new SecretService({ secretRefsCollection: refs, payloadStore: store, authorize: async () => {}, idGenerator: () => "example-secret", now: () => new Date("2026-01-01") });
  const session = { sub: "test-user" };
  await service.createSecret({ session, owner: { type: "user", id: "test-user" }, name: "Example", type: "api_key", plaintext: "first-private-value" });
  const first = await service.getSecretRevisionForUse({ session, secretId: "example-secret" });
  await expect(service.rotateSecret({ session, secretId: "example-secret", plaintext: "second-private-value" })).rejects.toThrow("metadata unavailable");
  const second = await service.getSecretRevisionForUse({ session, secretId: "example-secret" });
  expect(first).not.toBe(second);
  expect(second).not.toContain("private-value");
  expect(await store.getSecret("example-secret")).toBe("second-private-value");
});
