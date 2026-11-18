import { createHash,createCipheriv,createDecipheriv,randomBytes } from "crypto";

// assisted-by Codex Codex-sonnet-4-6

import { CredentialError,createCredentialError } from "./errors";
import { DataKeyContext,KeyWrapper } from "./key-wrapper";

interface EncryptedPayloadDocument {
  secretRefId: string;
  algorithm: "AES-256-GCM";
  ciphertext: string;
  maskedPreviewCiphertext?: string;
  encryptedDek: string;
  keyProvider: string;
  cmkId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

interface PayloadCollection {
  findOne(query: { secretRefId: string }): Promise<Record<string, unknown> | null>;
  updateOne(
    query: { secretRefId: string },
    update: { $set: Record<string, unknown>; $setOnInsert?: Record<string, unknown> },
    options: { upsert: boolean },
  ): Promise<unknown>;
  deleteOne?(query: { secretRefId: string }): Promise<unknown>;
}

interface CiphertextEnvelope {
  ciphertext: string;
  iv: string;
  tag: string;
}

export interface MongoEnvelopeCredentialStoreOptions {
  payloadCollection: PayloadCollection;
  keyWrapper: KeyWrapper | (() => KeyWrapper);
}

export interface PutSecretInput {
  secretRefId: string;
  plaintext: string;
  maskedPreview?: string;
}

function encodeJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64");
}

function decodeJson<T>(value: string): T {
  return JSON.parse(Buffer.from(value, "base64").toString("utf8")) as T;
}

function dataKeyContext(secretRefId: string): DataKeyContext {
  return {
    secretRefId,
    purpose: "credential-secret",
  };
}

function encryptPayload(plaintext: string, dataKey: Uint8Array, secretRefId: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(dataKey), iv);
  cipher.setAAD(Buffer.from(secretRefId, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const envelope: CiphertextEnvelope = {
    ciphertext: ciphertext.toString("base64"),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
  };

  return encodeJson(envelope);
}

function decryptPayload(ciphertextEnvelope: string, dataKey: Uint8Array, secretRefId: string): string {
  const envelope = decodeJson<CiphertextEnvelope>(ciphertextEnvelope);
  const decipher = createDecipheriv(
    "aes-256-gcm",
    Buffer.from(dataKey),
    Buffer.from(envelope.iv, "base64"),
  );
  decipher.setAAD(Buffer.from(secretRefId, "utf8"));
  decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));

  return Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

function asEncryptedPayload(document: Record<string, unknown>): EncryptedPayloadDocument {
  return document as unknown as EncryptedPayloadDocument;
}

export class MongoEnvelopeCredentialStore {
  private readonly payloadCollection: PayloadCollection;
  private readonly keyWrapperFactory: KeyWrapper | (() => KeyWrapper);
  private keyWrapper?: KeyWrapper;

  constructor(options: MongoEnvelopeCredentialStoreOptions) {
    this.payloadCollection = options.payloadCollection;
    this.keyWrapperFactory = options.keyWrapper;
  }

  private getKeyWrapper(): KeyWrapper {
    if (!this.keyWrapper) {
      this.keyWrapper = typeof this.keyWrapperFactory === "function"
        ? this.keyWrapperFactory()
        : this.keyWrapperFactory;
    }
    return this.keyWrapper;
  }

  async putSecret(input: PutSecretInput): Promise<void> {
    const context = dataKeyContext(input.secretRefId);
    const wrappedDataKey = await this.getKeyWrapper().generateDataKey(context);
    if (!wrappedDataKey.plaintextDataKey) {
      throw createCredentialError({
        reasonCode: "key_wrap_failed",
        message: "Credential data key generation failed",
        status: 500,
      });
    }

    const now = new Date();
    const payload = {
      secretRefId: input.secretRefId,
      algorithm: "AES-256-GCM",
      ciphertext: encryptPayload(
        input.plaintext,
        wrappedDataKey.plaintextDataKey,
        input.secretRefId,
      ),
      ...(input.maskedPreview !== undefined
        ? {
            maskedPreviewCiphertext: encryptPayload(
              input.maskedPreview,
              wrappedDataKey.plaintextDataKey,
              input.secretRefId,
            ),
          }
        : {}),
      encryptedDek: wrappedDataKey.encryptedDataKey,
      keyProvider: wrappedDataKey.keyProvider,
      cmkId: wrappedDataKey.cmkId,
      updatedAt: now,
    };

    await this.payloadCollection.updateOne(
      { secretRefId: input.secretRefId },
      { $set: payload, $setOnInsert: { createdAt: now } },
      { upsert: true },
    );
  }

  private async getPayload(secretRefId: string): Promise<EncryptedPayloadDocument> {
    const document = await this.payloadCollection.findOne({ secretRefId });
    if (!document) {
      throw createCredentialError({
        reasonCode: "credential_not_found",
        message: "Credential payload was not found",
        status: 404,
      });
    }

    return asEncryptedPayload(document);
  }

  private async decryptPayloadField(
    secretRefId: string,
    payload: EncryptedPayloadDocument,
    ciphertextEnvelope: string,
  ): Promise<string> {
    const dataKey = await this.getKeyWrapper().unwrapDataKey(
      payload.encryptedDek,
      dataKeyContext(secretRefId),
    );

    try {
      return decryptPayload(ciphertextEnvelope, dataKey, secretRefId);
    } catch {
      throw createCredentialError({
        reasonCode: "decrypt_failed",
        message: "Credential payload decrypt failed",
        status: 500,
      });
    }
  }

  async getSecret(secretRefId: string): Promise<string> {
    const payload = await this.getPayload(secretRefId);
    return this.decryptPayloadField(secretRefId, payload, payload.ciphertext);
  }

  async getSecretRevision(secretRefId: string): Promise<string> {
    const payload = await this.getPayload(secretRefId);
    return createHash("sha256").update(payload.ciphertext).digest("hex");
  }

  async getMaskedPreview(secretRefId: string): Promise<string> {
    const payload = await this.getPayload(secretRefId);
    if (!payload.maskedPreviewCiphertext) {
      throw createCredentialError({
        reasonCode: "credential_preview_not_found",
        message: "Credential preview payload was not found",
        status: 404,
      });
    }
    return this.decryptPayloadField(secretRefId, payload, payload.maskedPreviewCiphertext);
  }

  async rotateSecret(secretRefId: string): Promise<void> {
    const plaintext = await this.getSecret(secretRefId);
    let maskedPreview: string | undefined;
    try {
      maskedPreview = await this.getMaskedPreview(secretRefId);
    } catch (error) {
      if (
        !(error instanceof CredentialError) ||
        error.reasonCode !== "credential_preview_not_found"
      ) {
        throw error;
      }
    }
    await this.putSecret({ secretRefId, plaintext, maskedPreview });
  }

  async deleteSecret(secretRefId: string): Promise<void> {
    await this.payloadCollection.deleteOne?.({ secretRefId });
  }
}
