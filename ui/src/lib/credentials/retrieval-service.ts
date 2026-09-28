import { allowedSourceTypesForIngestorServiceAccount } from "@/lib/rbac/ingestor-service-accounts";
import type { ResourceAuthzSession } from "@/lib/rbac/resource-authz";

import { writeCredentialAuditEvent, type CredentialAuditActor } from "./audit";
import { createCredentialError } from "./errors";
import { assertCredentialServiceCaller } from "./internal-caller";

interface PayloadStore {
  getSecret(secretRefId: string): Promise<string>;
}

type AuthorizeSecretUse = (
  session: ResourceAuthzSession,
  target: { type: "secret_ref"; id: string; action: "use" },
) => Promise<void>;

export interface CredentialRetrievalServiceOptions {
  expectedAudience: string;
  payloadStore: PayloadStore;
  authorize: AuthorizeSecretUse;
  /**
   * Consulted only for a verified ingestor service-account session, requesting
   * `internal_service`, that the relationship check already refused — letting
   * that backend service read a credential the work it has been handed
   * genuinely depends on. `intended_use` and the caller-type header are both
   * caller-supplied, so neither can be the gate; the session subject is the
   * one claim `getAuthFromBearerOrSession` verified against the IdP.
   */
  authorizeByUsage?: (secretRef: string) => Promise<boolean>;
}

export interface RetrieveCredentialInput {
  headers: Headers;
  body: Record<string, unknown>;
  session: ResourceAuthzSession;
}

export interface RetrieveCredentialResult {
  secret_ref: string;
  credential: string;
}

const ALLOWED_INTENDED_USES = new Set(["mcp_server", "provider_exchange", "internal_service"]);

function validateRetrieveBody(
  body: Record<string, unknown>,
): { secretRef: string; intendedUse: string } {
  const secretRef = typeof body.secret_ref === "string" ? body.secret_ref.trim() : "";
  const intendedUse = typeof body.intended_use === "string" ? body.intended_use.trim() : "";

  if (!secretRef || !ALLOWED_INTENDED_USES.has(intendedUse)) {
    throw createCredentialError({
      reasonCode: "invalid_retrieval_request",
      message: "Credential retrieval request is invalid",
      status: 400,
    });
  }

  return { secretRef, intendedUse };
}

function callerLabel(headers: Headers): string {
  return headers.get("x-caipe-credential-caller")?.trim() || "unknown";
}

function auditActorFor(input: RetrieveCredentialInput): CredentialAuditActor {
  const subject = typeof input.session.sub === "string" ? input.session.sub : "unknown";
  return {
    type: input.session.isServiceAccount === true ? "service" : "user",
    id: subject,
  };
}

export class CredentialRetrievalService {
  private readonly expectedAudience: string;
  private readonly payloadStore: PayloadStore;
  private readonly authorize: AuthorizeSecretUse;
  private readonly authorizeByUsage?: (secretRef: string) => Promise<boolean>;

  constructor(options: CredentialRetrievalServiceOptions) {
    this.expectedAudience = options.expectedAudience;
    this.payloadStore = options.payloadStore;
    this.authorize = options.authorize;
    this.authorizeByUsage = options.authorizeByUsage;
  }

  async retrieve(input: RetrieveCredentialInput): Promise<RetrieveCredentialResult> {
    assertCredentialServiceCaller({
      headers: input.headers,
      expectedAudience: this.expectedAudience,
    });
    const { secretRef, intendedUse } = validateRetrieveBody(input.body);
    const actor = auditActorFor(input);

    try {
      await this.authorize(input.session, { type: "secret_ref", id: secretRef, action: "use" });
    } catch (error) {
      // `intended_use` is a value the caller chose; it can express intent but
      // must never grant it. A caller that isn't a recognized ingestor
      // service account has no path to this fallback no matter what it sets
      // that field to.
      const isRecognizedIngestor =
        allowedSourceTypesForIngestorServiceAccount(input.session) !== null;
      const allowedByUsage =
        intendedUse === "internal_service" &&
        isRecognizedIngestor &&
        this.authorizeByUsage !== undefined &&
        (await this.authorizeByUsage(secretRef));

      if (!allowedByUsage) {
        writeCredentialAuditEvent({
          action: "credential.retrieve",
          actor,
          resource: { type: "secret_ref", id: secretRef },
          result: "denied",
          details: { intended_use: intendedUse, caller: callerLabel(input.headers) },
        });
        throw error;
      }
    }

    const credential = await this.payloadStore.getSecret(secretRef);
    writeCredentialAuditEvent({
      action: "credential.retrieve",
      actor,
      resource: { type: "secret_ref", id: secretRef },
      result: "success",
      details: { intended_use: intendedUse, caller: callerLabel(input.headers) },
    });

    return { secret_ref: secretRef, credential };
  }
}
