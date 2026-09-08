// assisted-by Codex Codex-sonnet-4-6

import { ApiError } from "@/lib/api-error";
import {
  authzRevisionFilter,
  AuthzSyncSupersededError,
  hasActiveAuthzSync,
  nextAuthzRevision,
  runRevisionedAuthzSync,
  type AuthzSyncDocument,
} from "@/lib/authz/resource-sync";
import type { ResourceAuthzSession } from "@/lib/rbac/resource-authz";

import { writeCredentialAuditEvent } from "./audit";
import { CREDENTIAL_COLLECTIONS } from "./collections";
import { CredentialError } from "./errors";
import { isOpaqueMaskedPreview, maskCredentialValue } from "./masking";
import type { CredentialOwnerRef,CredentialSecretType } from "./types";

export interface SecretActorRef {
  type: "user" | "service_account";
  id: string;
  email?: string;
  name?: string;
  displayName?: string;
}

export interface SecretStorageMetadata {
  metadataCollection: string;
  payloadCollection: string;
  encryption: "AES-256-GCM envelope encryption";
  plaintextReadableByBrowser: false;
  valuePreviewAvailable: true;
}

export interface SecretUsageReference {
  type: "mcp_server" | "llm_provider";
  id: string;
  name: string;
  location: string;
  detail?: string;
}

export interface SecretRefDocument extends AuthzSyncDocument {
  id: string;
  owner: CredentialOwnerRef;
  createdBy?: SecretActorRef;
  name: string;
  type: CredentialSecretType;
  description?: string;
  sharedWithTeams: string[];
  visibility?: "private" | "team";
  createdAt: Date;
  updatedAt: Date;
  rotatedAt?: Date;
  authz_previous_state?: Record<string, unknown>;
}

export interface SecretMetadata {
  id: string;
  owner: CredentialOwnerRef;
  createdBy?: SecretActorRef;
  name: string;
  type: CredentialSecretType;
  description?: string;
  maskedPreview: string;
  sharedWithTeams: string[];
  visibility: "private" | "team";
  usage: SecretUsageReference[];
  storage: SecretStorageMetadata;
  createdAt: string;
  updatedAt: string;
  rotatedAt?: string;
  authzRevision?: number;
  authzSyncState?: "pending" | "ready" | "error";
  authzLastSyncedRevision?: number;
  authzLastErrorCode?: string;
}

interface SecretRefsCollection {
  insertOne(doc: SecretRefDocument): Promise<unknown>;
  find(query: Record<string, unknown>): {
    sort(sort: Record<string, 1 | -1>): { toArray(): Promise<SecretRefDocument[]> };
  };
  findOne(query: Record<string, unknown>): Promise<SecretRefDocument | null>;
  updateOne(
    query: Record<string, unknown>,
    update: Record<string, unknown>,
  ): Promise<{ matchedCount?: number; modifiedCount?: number }>;
  deleteOne(query: Record<string, unknown>): Promise<{ deletedCount?: number }>;
}

interface PayloadStore {
  putSecret(input: { secretRefId: string; plaintext: string; maskedPreview?: string }): Promise<void>;
  getSecret?(secretRefId: string): Promise<string>;
  getMaskedPreview(secretRefId: string): Promise<string>;
  deleteSecret?(secretRefId: string): Promise<void>;
}

type AuthorizeSecretAction = (
  session: ResourceAuthzSession,
  target: { type: "secret_ref"; id: string; action: "read-metadata" | "use" | "manage" | "share" | "audit" },
) => Promise<void>;

type ListReadableSecretIds = (session: ResourceAuthzSession) => Promise<string[]>;

export interface SecretServiceOptions {
  secretRefsCollection: SecretRefsCollection;
  payloadStore: PayloadStore;
  authorize: AuthorizeSecretAction;
  listReadableSecretIds?: ListReadableSecretIds;
  reconcileOwnerRelationships?: (input: {
    secretId: string;
    owner: CredentialOwnerRef;
    ownerSubject?: string | null;
  }) => Promise<void>;
  reconcileShare?: (secretId: string, teamId: string) => Promise<void>;
  deleteShare?: (secretId: string, teamId: string) => Promise<void>;
  deleteAllRelationships?: (secretId: string) => Promise<void>;
  resolveUsage?: (secret: SecretRefDocument) => Promise<SecretUsageReference[]>;
  idGenerator: () => string;
  now?: () => Date;
}

export interface CreateSecretInput {
  session: ResourceAuthzSession;
  owner: CredentialOwnerRef;
  name: string;
  type: CredentialSecretType;
  plaintext: string;
  description?: string;
}

export interface BootstrapSecretInput {
  id: string;
  owner: CredentialOwnerRef;
  name: string;
  type: CredentialSecretType;
  plaintext: string;
  description?: string;
  sharedWithTeams?: string[];
}

export type BootstrapSecretResult = "created" | "updated" | "unchanged";

export interface ListSecretsInput {
  session: ResourceAuthzSession;
  owner: CredentialOwnerRef;
}

export interface RotateSecretInput {
  session: ResourceAuthzSession;
  secretId: string;
  plaintext: string;
}

export interface SecretByIdInput {
  session: ResourceAuthzSession;
  secretId: string;
}

export interface SecretShareInput extends SecretByIdInput {
  teamId: string;
}

export interface AdminUpdateSecretMetadataInput {
  secretId: string;
  name?: string;
  description?: string;
}

const MASKED_PREVIEW_UNAVAILABLE = "unavailable";
const SECRET_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._~@|*+=,/-]{0,191}$/;

function requireNonEmptyString(value: string, field: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new ApiError(`${field} is required`, 400, "VALIDATION_ERROR");
  }
  return trimmed;
}

function normalizedTeamIds(values: string[] | undefined): string[] {
  return Array.from(
    new Set((values ?? []).map((value) => value.trim()).filter(Boolean)),
  ).sort();
}

function sameOwner(left: CredentialOwnerRef, right: CredentialOwnerRef): boolean {
  return left.type === right.type && left.id === right.id;
}

function sameStrings(left: string[] | undefined, right: string[]): boolean {
  const normalizedLeft = normalizedTeamIds(left);
  return normalizedLeft.length === right.length
    && normalizedLeft.every((value, index) => value === right[index]);
}

function actorFromSession(session: ResourceAuthzSession): SecretActorRef | undefined {
  const id = typeof session.sub === "string" && session.sub.trim() ? session.sub.trim() : "";
  if (!id) return undefined;
  const sessionUser = session.user as
    | { email?: string | null; name?: string | null; displayName?: string | null }
    | null
    | undefined;
  const email = typeof sessionUser?.email === "string" && sessionUser.email.trim()
    ? sessionUser.email.trim()
    : undefined;
  const name = typeof sessionUser?.name === "string" && sessionUser.name.trim()
    ? sessionUser.name.trim()
    : undefined;
  const displayName = typeof sessionUser?.displayName === "string" && sessionUser.displayName.trim()
    ? sessionUser.displayName.trim()
    : undefined;
  return {
    type: session.isServiceAccount === true ? "service_account" : "user",
    id,
    ...(email ? { email } : {}),
    ...(name ? { name } : {}),
    ...(displayName ? { displayName } : {}),
  };
}

function secretStorageMetadata(): SecretStorageMetadata {
  return {
    metadataCollection: CREDENTIAL_COLLECTIONS.secretRefs,
    payloadCollection: CREDENTIAL_COLLECTIONS.encryptedPayloads,
    encryption: "AES-256-GCM envelope encryption",
    plaintextReadableByBrowser: false,
    valuePreviewAvailable: true,
  };
}

function toMetadata(
  doc: SecretRefDocument,
  maskedPreview: string,
  usage: SecretUsageReference[] = [],
): SecretMetadata {
  return {
    id: doc.id,
    owner: doc.owner,
    createdBy: doc.createdBy,
    name: doc.name,
    type: doc.type,
    description: doc.description,
    maskedPreview,
    sharedWithTeams: doc.sharedWithTeams ?? [],
    visibility: doc.visibility ?? (
      doc.owner.type === "user" && (doc.sharedWithTeams?.length ?? 0) === 0
        ? "private"
        : "team"
    ),
    usage,
    storage: secretStorageMetadata(),
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
    rotatedAt: doc.rotatedAt?.toISOString(),
    authzRevision: doc.authz_revision,
    authzSyncState: doc.authz_sync_state,
    authzLastSyncedRevision: doc.authz_last_synced_revision,
    authzLastErrorCode: doc.authz_last_error_code,
  };
}

export class SecretService {
  private readonly secretRefsCollection: SecretRefsCollection;
  private readonly payloadStore: PayloadStore;
  private readonly authorize: AuthorizeSecretAction;
  private readonly listReadableSecretIds: ListReadableSecretIds;
  private readonly reconcileOwnerRelationships: NonNullable<SecretServiceOptions["reconcileOwnerRelationships"]>;
  private readonly reconcileShare: NonNullable<SecretServiceOptions["reconcileShare"]>;
  private readonly deleteShare: NonNullable<SecretServiceOptions["deleteShare"]>;
  private readonly deleteAllRelationships: NonNullable<SecretServiceOptions["deleteAllRelationships"]>;
  private readonly resolveUsage: NonNullable<SecretServiceOptions["resolveUsage"]>;
  private readonly idGenerator: () => string;
  private readonly now: () => Date;

  constructor(options: SecretServiceOptions) {
    this.secretRefsCollection = options.secretRefsCollection;
    this.payloadStore = options.payloadStore;
    this.authorize = options.authorize;
    this.listReadableSecretIds = options.listReadableSecretIds ?? (async () => []);
    this.reconcileOwnerRelationships = options.reconcileOwnerRelationships ?? (async () => undefined);
    this.reconcileShare = options.reconcileShare ?? (async () => undefined);
    this.deleteShare = options.deleteShare ?? (async () => undefined);
    this.deleteAllRelationships = options.deleteAllRelationships ?? (async () => undefined);
    this.resolveUsage = options.resolveUsage ?? (async () => []);
    this.idGenerator = options.idGenerator;
    this.now = options.now ?? (() => new Date());
  }

  async createSecret(input: CreateSecretInput): Promise<SecretMetadata> {
    const name = requireNonEmptyString(input.name, "name");
    const plaintext = requireNonEmptyString(input.plaintext, "plaintext");
    const id = this.idGenerator();
    const now = this.now();
    const maskedPreview = maskCredentialValue(plaintext);

    const doc: SecretRefDocument = {
      id,
      owner: input.owner,
      createdBy: actorFromSession(input.session),
      name,
      type: input.type,
      description: input.description?.trim() || undefined,
      sharedWithTeams: [],
      visibility: input.owner.type === "user" ? "private" : "team",
      createdAt: now,
      updatedAt: now,
      rotatedAt: now,
      authz_revision: 1,
      authz_sync_state: "ready",
      authz_last_synced_revision: 1,
    };

    await this.payloadStore.putSecret({ secretRefId: id, plaintext, maskedPreview });
    await this.reconcileOwnerRelationships({
      secretId: id,
      owner: input.owner,
      ownerSubject: typeof input.session.sub === "string" ? input.session.sub : null,
    });
    await this.secretRefsCollection.insertOne(doc);
    writeCredentialAuditEvent({
      action: "credential.create",
      actor: { type: "user", id: String(input.session.sub ?? "unknown") },
      resource: { type: "secret_ref", id },
      result: "success",
    });

    return this.metadataFor(doc, maskedPreview);
  }

  async upsertBootstrapSecret(input: BootstrapSecretInput): Promise<BootstrapSecretResult> {
    const id = requireNonEmptyString(input.id, "id");
    if (!SECRET_ID_PATTERN.test(id)) {
      throw new ApiError("id is not a valid secret reference identifier", 400, "VALIDATION_ERROR");
    }
    if (input.owner.type !== "team" && input.owner.type !== "user") {
      throw new ApiError(
        "bootstrap secret owner.type must be team or user",
        400,
        "VALIDATION_ERROR",
      );
    }
    const ownerId = requireNonEmptyString(input.owner.id, "owner.id");
    if (!SECRET_ID_PATTERN.test(ownerId)) {
      throw new ApiError("owner.id is not a valid identifier", 400, "VALIDATION_ERROR");
    }
    const owner: CredentialOwnerRef = { type: input.owner.type, id: ownerId };
    const name = requireNonEmptyString(input.name, "name");
    const plaintext = requireNonEmptyString(input.plaintext, "plaintext");
    const description = input.description?.trim() || undefined;
    const sharedWithTeams = normalizedTeamIds(input.sharedWithTeams);
    if (sharedWithTeams.some((teamId) => !SECRET_ID_PATTERN.test(teamId))) {
      throw new ApiError(
        "sharedWithTeams contains an invalid team identifier",
        400,
        "VALIDATION_ERROR",
      );
    }
    const existing = await this.secretRefsCollection.findOne({ id });
    const now = this.now();

    let storedPlaintext: string | null = null;
    if (this.payloadStore.getSecret) {
      try {
        storedPlaintext = await this.payloadStore.getSecret(id);
      } catch {
        storedPlaintext = null;
      }
    }
    const secretChanged = storedPlaintext !== plaintext;
    if (secretChanged) {
      await this.payloadStore.putSecret({
        secretRefId: id,
        plaintext,
        maskedPreview: maskCredentialValue(plaintext),
      });
    }

    const relationshipsChanged = Boolean(
      existing
      && (!sameOwner(existing.owner, owner)
        || !sameStrings(existing.sharedWithTeams, sharedWithTeams)),
    );
    if (relationshipsChanged) {
      await this.deleteAllRelationships(id);
    }
    await this.reconcileOwnerRelationships({
      secretId: id,
      owner,
      ownerSubject: owner.type === "user" ? owner.id : null,
    });
    for (const teamId of sharedWithTeams) {
      await this.reconcileShare(id, teamId);
    }

    const metadataChanged = !existing
      || !sameOwner(existing.owner, owner)
      || existing.name !== name
      || existing.type !== input.type
      || existing.description !== description
      || !sameStrings(existing.sharedWithTeams, sharedWithTeams);
    const doc: SecretRefDocument = {
      id,
      owner,
      createdBy: existing?.createdBy ?? {
        type: "service_account",
        id: "credential-bootstrap",
        name: "Credential bootstrap",
      },
      name,
      type: input.type,
      description,
      sharedWithTeams,
      visibility: owner.type === "user" && sharedWithTeams.length === 0 ? "private" : "team",
      createdAt: existing?.createdAt ?? now,
      updatedAt: metadataChanged || secretChanged ? now : existing?.updatedAt ?? now,
      rotatedAt: secretChanged ? now : existing?.rotatedAt,
    };

    if (!existing) {
      await this.secretRefsCollection.insertOne(doc);
      return "created";
    }
    if (metadataChanged || secretChanged) {
      const requiredDoc = { ...doc };
      delete requiredDoc.description;
      await this.secretRefsCollection.updateOne(
        { id },
        {
          $set: description ? doc : requiredDoc,
          ...(!description ? { $unset: { description: "" } } : {}),
        },
      );
      return "updated";
    }
    return "unchanged";
  }

  async listSecrets(input: ListSecretsInput): Promise<SecretMetadata[]> {
    const docsById = new Map<string, SecretRefDocument>();
    const ownedDocs = await this.secretRefsCollection
      .find({ "owner.type": input.owner.type, "owner.id": input.owner.id })
      .sort({ name: 1 })
      .toArray();
    for (const doc of ownedDocs) {
      docsById.set(doc.id, doc);
    }

    let readableSecretIds: string[] = [];
    try {
      readableSecretIds = await this.listReadableSecretIds(input.session);
    } catch {
      readableSecretIds = [];
    }
    const missingReadableIds = Array.from(new Set(readableSecretIds)).filter(
      (secretId) => !docsById.has(secretId),
    );
    if (missingReadableIds.length > 0) {
      const readableDocs = await this.secretRefsCollection
        .find({ id: { $in: missingReadableIds } })
        .sort({ name: 1 })
        .toArray();
      for (const doc of readableDocs) {
        docsById.set(doc.id, doc);
      }
    }

    const visible: SecretMetadata[] = [];
    const docs = Array.from(docsById.values()).sort((a, b) => a.name.localeCompare(b.name));
    for (const doc of docs) {
      try {
        await this.authorize(input.session, {
          type: "secret_ref",
          id: doc.id,
          action: "read-metadata",
        });
        visible.push(await this.metadataFor(doc));
      } catch {
        // Drop denied resources from list responses to avoid disclosing existence.
      }
    }
    return visible;
  }

  async listAllSecretsForAdmin(): Promise<SecretMetadata[]> {
    const docs = await this.secretRefsCollection.find({}).sort({ updatedAt: -1 }).toArray();
    return Promise.all(docs.map((doc) => this.metadataFor(doc)));
  }

  async updateSecretMetadataForAdmin(input: AdminUpdateSecretMetadataInput): Promise<SecretMetadata> {
    const doc = await this.getSecretRef(input.secretId);
    const update: Partial<SecretRefDocument> = { updatedAt: this.now() };
    if (input.name !== undefined) {
      update.name = requireNonEmptyString(input.name, "name");
    }
    if (input.description !== undefined) {
      update.description = input.description.trim() || undefined;
    }
    await this.secretRefsCollection.updateOne({ id: input.secretId }, { $set: update });
    return this.metadataFor({ ...doc, ...update });
  }

  async deleteSecretForAdmin(secretId: string): Promise<void> {
    await this.getSecretRef(secretId);
    await this.payloadStore.deleteSecret?.(secretId);
    await this.deleteAllRelationships(secretId);
    await this.secretRefsCollection.deleteOne({ id: secretId });
  }

  async getSecretMetadata(input: SecretByIdInput): Promise<SecretMetadata> {
    const doc = await this.getSecretRef(input.secretId);
    await this.authorize(input.session, { type: "secret_ref", id: input.secretId, action: "read-metadata" });
    return this.metadataFor(doc);
  }

  async rotateSecret(input: RotateSecretInput): Promise<SecretMetadata> {
    const plaintext = requireNonEmptyString(input.plaintext, "plaintext");
    const doc = await this.getSecretRef(input.secretId);
    await this.authorize(input.session, { type: "secret_ref", id: input.secretId, action: "manage" });

    const now = this.now();
    const maskedPreview = maskCredentialValue(plaintext);
    await this.payloadStore.putSecret({
      secretRefId: input.secretId,
      plaintext,
      maskedPreview,
    });
    await this.secretRefsCollection.updateOne(
      { id: input.secretId },
      {
        $set: {
          updatedAt: now,
          rotatedAt: now,
        },
      },
    );
    writeCredentialAuditEvent({
      action: "credential.rotate",
      actor: { type: "user", id: String(input.session.sub ?? "unknown") },
      resource: { type: "secret_ref", id: input.secretId },
      result: "success",
    });

    return this.metadataFor({
      ...doc,
      updatedAt: now,
      rotatedAt: now,
    }, maskedPreview);
  }

  async shareSecret(input: SecretShareInput): Promise<void> {
    const doc = await this.getSecretRef(input.secretId);
    await this.authorize(input.session, { type: "secret_ref", id: input.secretId, action: "share" });
    const teamId = requireNonEmptyString(input.teamId, "teamId");
    await this.updateSecretShareAuthorization({ doc, teamId, revoke: false });
  }

  async revokeSecretShare(input: SecretShareInput): Promise<void> {
    const doc = await this.getSecretRef(input.secretId);
    await this.authorize(input.session, { type: "secret_ref", id: input.secretId, action: "share" });
    const teamId = requireNonEmptyString(input.teamId, "teamId");
    await this.updateSecretShareAuthorization({ doc, teamId, revoke: true });
  }

  private async updateSecretShareAuthorization(input: {
    doc: SecretRefDocument;
    teamId: string;
    revoke: boolean;
  }): Promise<void> {
    if (hasActiveAuthzSync(input.doc)) {
      throw new ApiError(
        "This credential's authorization is already being reconciled. Retry shortly.",
        409,
        "AUTHZ_SYNC_PENDING",
      );
    }
    const nextTeams = input.revoke
      ? normalizedTeamIds(input.doc.sharedWithTeams).filter((team) => team !== input.teamId)
      : normalizedTeamIds([...input.doc.sharedWithTeams, input.teamId]);
    const revision = nextAuthzRevision(input.doc);
    const pendingResult = await this.secretRefsCollection.updateOne(
      { id: input.doc.id, ...authzRevisionFilter(input.doc) },
      {
        $set: {
          sharedWithTeams: nextTeams,
          visibility: input.doc.owner.type === "user" && nextTeams.length === 0
            ? "private"
            : "team",
          authz_revision: revision,
          authz_sync_state: "pending",
          authz_sync_started_at: this.now().toISOString(),
          authz_previous_state: input.doc.authz_previous_state ?? {
            sharedWithTeams: input.doc.sharedWithTeams,
            visibility: input.doc.visibility,
          },
        },
        $unset: { authz_last_error_code: "" },
      },
    );
    if (pendingResult.matchedCount === 0) {
      throw new ApiError(
        "This credential changed while authorization was being prepared. Retry the update.",
        409,
        "AUTHZ_SYNC_SUPERSEDED",
      );
    }

    try {
      await runRevisionedAuthzSync({
        reconcile: () => input.revoke
          ? this.deleteShare(input.doc.id, input.teamId)
          : this.reconcileShare(input.doc.id, input.teamId),
        markError: async (errorCode) => {
          await this.secretRefsCollection.updateOne(
            { id: input.doc.id, authz_revision: revision, authz_sync_state: "pending" },
            {
              $set: { authz_sync_state: "error", authz_last_error_code: errorCode },
              $unset: { authz_sync_started_at: "" },
            },
          );
        },
        markReady: async () => {
          const result = await this.secretRefsCollection.updateOne(
            { id: input.doc.id, authz_revision: revision, authz_sync_state: "pending" },
            {
              $set: {
                authz_sync_state: "ready",
                authz_last_synced_revision: revision,
              },
              $unset: {
                authz_last_error_code: "",
                authz_previous_state: "",
                authz_sync_started_at: "",
              },
            },
          );
          return result.matchedCount === 0 ? null : result;
        },
      });
    } catch (error) {
      if (error instanceof AuthzSyncSupersededError) {
        throw new ApiError(error.message, 409, "AUTHZ_SYNC_SUPERSEDED");
      }
      throw error;
    }
  }

  async deleteSecret(input: SecretByIdInput): Promise<void> {
    await this.getSecretRef(input.secretId);
    await this.authorize(input.session, { type: "secret_ref", id: input.secretId, action: "manage" });
    await this.payloadStore.deleteSecret?.(input.secretId);
    await this.deleteAllRelationships(input.secretId);
    await this.secretRefsCollection.deleteOne({ id: input.secretId });
  }

  private async getSecretRef(secretId: string): Promise<SecretRefDocument> {
    const doc = await this.secretRefsCollection.findOne({ id: secretId });
    if (!doc) {
      throw new ApiError("Credential secret was not found", 404, "CREDENTIAL_NOT_FOUND");
    }
    return doc;
  }

  private async metadataFor(
    doc: SecretRefDocument,
    maskedPreviewOverride?: string,
  ): Promise<SecretMetadata> {
    const [usage, maskedPreview] = await Promise.all([
      this.resolveUsage(doc),
      this.maskedPreviewFor(doc.id, maskedPreviewOverride),
    ]);
    return toMetadata(doc, maskedPreview, usage);
  }

  private async maskedPreviewFor(secretId: string, maskedPreviewOverride?: string): Promise<string> {
    if (maskedPreviewOverride !== undefined) {
      return maskedPreviewOverride;
    }

    try {
      const storedMaskedPreview = await this.payloadStore.getMaskedPreview(secretId);
      return await this.repairOpaqueMaskedPreview(secretId, storedMaskedPreview);
    } catch (error) {
      const reason = error instanceof CredentialError ? error.reasonCode : "unknown";
      console.warn("[credentials] masked preview unavailable", { secretId, reason });
      return MASKED_PREVIEW_UNAVAILABLE;
    }
  }

  private async repairOpaqueMaskedPreview(secretId: string, maskedPreview: string): Promise<string> {
    if (!isOpaqueMaskedPreview(maskedPreview) || !this.payloadStore.getSecret) {
      return maskedPreview;
    }

    const plaintext = await this.payloadStore.getSecret(secretId);
    const repairedPreview = maskCredentialValue(plaintext);
    if (repairedPreview === maskedPreview) {
      return maskedPreview;
    }

    await this.payloadStore.putSecret({
      secretRefId: secretId,
      plaintext,
      maskedPreview: repairedPreview,
    });
    return repairedPreview;
  }
}
