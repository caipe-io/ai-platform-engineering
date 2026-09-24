import { randomUUID } from "crypto";

// assisted-by Codex Codex-sonnet-4-6

import { KMSClient } from "@aws-sdk/client-kms";

import { getCollection } from "@/lib/mongodb";
import { listOpenFgaObjects } from "@/lib/rbac/openfga";
import { requireResourcePermission,subjectFromSession,type ResourceAuthzSession } from "@/lib/rbac/resource-authz";

import { CREDENTIAL_COLLECTIONS } from "./collections";
import { createAwsKmsKeyWrapper,createDevLocalKeyWrapper,createLocalCmkKeyWrapper } from "./key-wrapper";
import { MongoEnvelopeCredentialStore } from "./mongo-envelope-store";
import {
deleteAllSecretRefRelationships,
deleteSecretRefShare,
reconcileSecretRefOwnerRelationships,
reconcileSecretRefShare,
} from "./secret-openfga";
import { SecretService,type SecretRefDocument,type SecretUsageReference } from "./secret-service";

interface IngestionSourceSecretUsageDocument {
  source_id: string;
  name?: string;
  settings?: {
    auth_headers?: Array<{ header_name?: string; secret_ref?: string }>;
  };
}

interface McpServerSecretUsageDocument {
  _id: string;
  name?: string;
  credential_sources?: Array<{
    kind?: string;
    target?: string;
    name?: string;
    secret_ref?: string;
  }>;
}

const LLM_PROVIDER_NAMES: Record<string, string> = {
  openai: "OpenAI",
  "anthropic-claude": "Anthropic Claude",
  "azure-openai": "Azure OpenAI",
  "aws-bedrock": "AWS Bedrock",
  "google-genai": "Google Gemini",
};

function createConfiguredKeyWrapper() {
  const keyProvider = process.env.CREDENTIAL_KEY_PROVIDER?.trim() || "local-cmk";
  if (keyProvider === "aws-kms") {
    return createAwsKmsKeyWrapper({
      client: new KMSClient({ region: process.env.CREDENTIAL_KMS_REGION }),
      cmkId: process.env.CREDENTIAL_KMS_CMK_ID || process.env.CREDENTIAL_KMS_KEY_ID || "",
    });
  }

  if (keyProvider === "local-cmk") {
    return createLocalCmkKeyWrapper({
      cmkId: process.env.CREDENTIAL_KMS_CMK_ID || "alias/caipe-local-credentials",
      nodeEnv: process.env.NODE_ENV,
    });
  }

  return createDevLocalKeyWrapper({
    masterKey:
      process.env.CREDENTIAL_DEV_LOCAL_MASTER_KEY ||
      process.env.CREDENTIAL_KMS_CMK_ID ||
      "caipe-local-development-credential-key",
    nodeEnv: process.env.NODE_ENV,
  });
}

function llmProviderUsage(secret: SecretRefDocument): SecretUsageReference[] {
  const match = /^llm:([^:]+):(.+)$/.exec(secret.name);
  if (!match) return [];
  const [, providerId, field] = match;
  const providerName = LLM_PROVIDER_NAMES[providerId] ?? providerId;
  return [
    {
      type: "llm_provider",
      id: providerId,
      name: `${providerName} ${field.replace(/_/g, " ")}`,
      location: "Agents > Model Providers",
      detail: "Resolved by provider credential naming convention",
    },
  ];
}

export function createSecretUsageResolver() {
  let mcpServersPromise: Promise<McpServerSecretUsageDocument[]> | null = null;
  let ingestionSourcesPromise: Promise<IngestionSourceSecretUsageDocument[]> | null = null;

  async function mcpServers(): Promise<McpServerSecretUsageDocument[]> {
    mcpServersPromise ??= getCollection<McpServerSecretUsageDocument>("mcp_servers")
      .then((collection) =>
        collection
          .find({ "credential_sources.kind": "secret_ref" } as never)
          .toArray(),
      );
    return mcpServersPromise;
  }

  async function ingestionSources(): Promise<IngestionSourceSecretUsageDocument[]> {
    ingestionSourcesPromise ??= getCollection<IngestionSourceSecretUsageDocument>(
      "rag_ingestion_sources",
    ).then((collection) =>
      collection
        .find({ "settings.auth_headers.secret_ref": { $exists: true } } as never)
        .toArray(),
    );
    return ingestionSourcesPromise;
  }

  return async (secret: SecretRefDocument): Promise<SecretUsageReference[]> => {
    const usage = [...llmProviderUsage(secret)];
    for (const server of await mcpServers()) {
      for (const source of server.credential_sources ?? []) {
        if (source.kind !== "secret_ref" || source.secret_ref !== secret.id) continue;
        usage.push({
          type: "mcp_server",
          id: String(server._id),
          name: server.name || String(server._id),
          location: "Agents > Tools",
          detail: [source.target, source.name].filter(Boolean).join(": "),
        });
      }
    }
    for (const source of await ingestionSources()) {
      for (const header of source.settings?.auth_headers ?? []) {
        if (header.secret_ref !== secret.id) continue;
        usage.push({
          type: "ingestion_source",
          id: source.source_id,
          name: source.name || source.source_id,
          location: "Knowledge Bases > Ingest",
          detail: header.header_name,
        });
      }
    }
    return usage;
  };
}

function secretIdFromOpenFgaObject(object: string): string | null {
  const prefix = "secret_ref:";
  return object.startsWith(prefix) ? object.slice(prefix.length) : null;
}

function createReadableSecretLister() {
  return async (session: ResourceAuthzSession): Promise<string[]> => {
    const subject = subjectFromSession(session);
    if (!subject) return [];
    const result = await listOpenFgaObjects({
      user: subject,
      relation: "can_read_metadata",
      type: "secret_ref",
    });
    return Array.from(
      new Set(
        result.objects
          .map(secretIdFromOpenFgaObject)
          .filter((secretId): secretId is string => Boolean(secretId)),
      ),
    );
  };
}

export async function getCredentialSecretService(): Promise<SecretService> {
  const secretRefsCollection = await getCollection<SecretRefDocument>(
    CREDENTIAL_COLLECTIONS.secretRefs,
  );
  const encryptedPayloadsCollection = await getCollection(
    CREDENTIAL_COLLECTIONS.encryptedPayloads,
  );

  return new SecretService({
    secretRefsCollection,
    payloadStore: new MongoEnvelopeCredentialStore({
      payloadCollection: encryptedPayloadsCollection,
      keyWrapper: createConfiguredKeyWrapper(),
    }),
    authorize: requireResourcePermission,
    listReadableSecretIds: createReadableSecretLister(),
    reconcileOwnerRelationships: reconcileSecretRefOwnerRelationships,
    reconcileShare: reconcileSecretRefShare,
    deleteShare: deleteSecretRefShare,
    deleteAllRelationships: deleteAllSecretRefRelationships,
    resolveUsage: createSecretUsageResolver(),
    idGenerator: randomUUID,
  });
}
