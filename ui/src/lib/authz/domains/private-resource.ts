import { CREDENTIAL_COLLECTIONS } from "@/lib/credentials/collections";
import { getCollection } from "@/lib/mongodb";
import { isPrivateResourcesEnabled } from "@/lib/feature-flags/private-resources";

import type {
  Action,
  AuthorizeRequest,
  AuthorizeResult,
  ResourceType,
  Subject,
  TrustedAuthorizeContext,
} from "../contract";
import {
  AUTHZ_SYNC_GATED_ACTIONS,
  authzSyncPreCheck,
  type AuthzSyncDocument,
} from "../resource-sync";
import {
  evaluatePrivateResourceContext,
  PRIVATE_DATA_ACTIONS,
  type ResourceVisibility,
} from "./private-resource-policy";

export { evaluatePrivateResourceContext } from "./private-resource-policy";

interface VisibilityDocument extends AuthzSyncDocument {
  _id?: string;
  id?: string;
  visibility?: string;
  owner?: { type?: string };
  sharedWithTeams?: string[];
}

async function loadResourceState(req: AuthorizeRequest): Promise<VisibilityDocument | null> {
  let document: VisibilityDocument | null = null;
  if (req.resource.type === "agent") {
    const collection = await getCollection<VisibilityDocument>("dynamic_agents");
    document = await collection.findOne({ _id: req.resource.id });
  } else if (req.resource.type === "mcp_server") {
    const collection = await getCollection<VisibilityDocument>("mcp_servers");
    document = await collection.findOne({ _id: req.resource.id });
  } else if (req.resource.type === "secret_ref") {
    const collection = await getCollection<VisibilityDocument>(CREDENTIAL_COLLECTIONS.secretRefs);
    document = await collection.findOne({ id: req.resource.id });
  } else {
    return null;
  }
  return document;
}

async function loadResourceStates(
  resourceType: ResourceType,
  ids: string[],
): Promise<VisibilityDocument[]> {
  if (ids.length === 0) return [];
  if (resourceType === "agent") {
    return getCollection<VisibilityDocument>("dynamic_agents")
      .then((collection) => collection.find({ _id: { $in: ids } }).toArray());
  }
  if (resourceType === "mcp_server") {
    return getCollection<VisibilityDocument>("mcp_servers")
      .then((collection) => collection.find({ _id: { $in: ids } }).toArray());
  }
  if (resourceType === "secret_ref") {
    return getCollection<VisibilityDocument>(CREDENTIAL_COLLECTIONS.secretRefs)
      .then((collection) => collection.find({ id: { $in: ids } }).toArray());
  }
  return [];
}

function visibilityFromDocument(
  req: AuthorizeRequest,
  document: VisibilityDocument | null,
): ResourceVisibility {
  if (!document) return null;
  if (document.visibility === "private" || document.visibility === "team" || document.visibility === "global") {
    return document.visibility;
  }
  if (req.resource.type === "secret_ref") {
    return document.owner?.type === "user" && (document.sharedWithTeams?.length ?? 0) === 0
      ? "private"
      : "team";
  }
  return null;
}

export async function privateResourcePreCheck(req: AuthorizeRequest): Promise<AuthorizeResult | null> {
  if (!AUTHZ_SYNC_GATED_ACTIONS.has(req.action) && !PRIVATE_DATA_ACTIONS.has(req.action)) return null;
  const document = await loadResourceState(req);
  if (!document) return null;
  const syncDecision = AUTHZ_SYNC_GATED_ACTIONS.has(req.action)
    ? authzSyncPreCheck(document)
    : null;
  if (syncDecision || !isPrivateResourcesEnabled()) return syncDecision;
  return evaluatePrivateResourceContext(req, visibilityFromDocument(req, document));
}

export async function privateResourceBatchPreChecks(input: {
  subject: Subject;
  action: Action;
  resourceType: ResourceType;
  ids: string[];
  trustedContext?: TrustedAuthorizeContext;
}): Promise<Map<string, AuthorizeResult>> {
  const decisions = new Map<string, AuthorizeResult>();
  if (
    !AUTHZ_SYNC_GATED_ACTIONS.has(input.action)
    && !PRIVATE_DATA_ACTIONS.has(input.action)
  ) return decisions;
  const documents = await loadResourceStates(input.resourceType, input.ids);
  for (const document of documents) {
    const id = input.resourceType === "secret_ref" ? document.id : document._id;
    if (!id) continue;
    const syncDecision = AUTHZ_SYNC_GATED_ACTIONS.has(input.action)
      ? authzSyncPreCheck(document)
      : null;
    if (syncDecision) {
      decisions.set(id, syncDecision);
      continue;
    }
    if (!isPrivateResourcesEnabled() || !PRIVATE_DATA_ACTIONS.has(input.action)) continue;
    const request: AuthorizeRequest = {
      subject: input.subject,
      action: input.action,
      resource: { type: input.resourceType, id },
      trustedContext: input.trustedContext,
    };
    const contextDecision = evaluatePrivateResourceContext(
      request,
      visibilityFromDocument(request, document),
    );
    if (contextDecision) decisions.set(id, contextDecision);
  }
  return decisions;
}
