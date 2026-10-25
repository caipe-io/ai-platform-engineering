import { CREDENTIAL_COLLECTIONS } from "@/lib/credentials/collections";
import { getCollection } from "@/lib/mongodb";
import { isPrivateResourcesEnabled } from "@/lib/feature-flags/private-resources";

import type { AuthorizeRequest, AuthorizeResult } from "../contract";
import {
  evaluatePrivateResourceContext,
  PRIVATE_DATA_ACTIONS,
  type ResourceVisibility,
} from "./private-resource-policy";

export { evaluatePrivateResourceContext } from "./private-resource-policy";

interface VisibilityDocument {
  _id?: string;
  id?: string;
  visibility?: string;
  owner?: { type?: string; id?: string };
  owner_subject?: string;
  owner_subject_kind?: string;
  sharedWithTeams?: string[];
}

async function loadResource(req: AuthorizeRequest): Promise<VisibilityDocument | null> {
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

function visibilityOf(document: VisibilityDocument, resourceType: string): ResourceVisibility {
  if (document.visibility === "private" || document.visibility === "team" || document.visibility === "global") {
    return document.visibility;
  }
  return resourceType === "secret_ref" && document.owner?.type === "user"
    && (document.sharedWithTeams?.length ?? 0) === 0 ? "private" : null;
}

export async function privateResourcePreCheck(req: AuthorizeRequest): Promise<AuthorizeResult | null> {
  if (!isPrivateResourcesEnabled() || !PRIVATE_DATA_ACTIONS.has(req.action)) return null;
  const resource = await loadResource(req);
  if (!resource) return null;
  const visibility = visibilityOf(resource, req.resource.type);
  if (visibility === "private") {
    const owner = req.resource.type === "secret_ref" ? resource.owner?.id : resource.owner_subject;
    if (req.subject.type !== "user" || !owner || owner !== req.subject.id) {
      return { decision: "DENY", reason: "NO_CAPABILITY", retriable: false, via: "private_resource_owner" };
    }
  }
  return evaluatePrivateResourceContext(req, visibility);
}
