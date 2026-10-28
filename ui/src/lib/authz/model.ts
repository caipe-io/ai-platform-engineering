import { bundledAuthorizationModel, installedAuthorizationModules } from "@/native-extensions/authorization.generated";
import { authorizationModelsEqual } from "../../../app-sdk/authorization-model.mjs";
import { loadConfiguredAgenticApps } from "@/lib/agentic-apps/config";
import { resourceApp } from "@/lib/agentic-apps/service-binding";
import { UNIVERSAL_REBAC_RESOURCE_TYPE_NAMES } from "@/types/rbac-universal";
import { HttpAuthzError } from "./errors";
import { resolveOpenFgaModelId, getOpenFgaStoreId, OPENFGA_READ_TIMEOUT_MS, requestOpenFga } from "./engines/openfga-client";

export interface RelationReference {
  type: string;
  relation?: string;
  wildcard?: object;
  condition?: string;
}
export interface ModelType {
  type: string;
  relations?: Record<string, object>;
  metadata?: { module?: string; relations?: Record<string, { directly_related_user_types?: RelationReference[] }> };
}
interface SelectedModel { id: string; schema_version: string; type_definitions: ModelType[] }

const coreTypes = new Set<string>([...UNIVERSAL_REBAC_RESOURCE_TYPE_NAMES, "service_account", "anonymous"]);
export function isNativeResourceType(type: string): boolean { return !coreTypes.has(type); }
export const MODEL_NAME_PATTERN = /^[a-z][a-z0-9_]{0,49}$/;
let cached: { key: string; model: Promise<SelectedModel> } | undefined;

/** Read exactly the immutable model used by the transport; failed reads may retry. */
export async function selectedModel(): Promise<SelectedModel> {
  const id = await resolveOpenFgaModelId();
  if (!id) throw new Error("No immutable model is selected for this build");
  const storeId = await getOpenFgaStoreId();
  const key = `${process.env.OPENFGA_HTTP}|${storeId}|${id}`;
  if (cached?.key !== key) {
    const model = (async () => {
      const response = await requestOpenFga(`/stores/${storeId}/authorization-models/${id}`, {
        method: "GET", signal: AbortSignal.timeout(OPENFGA_READ_TIMEOUT_MS),
      });
      if (!response.ok) throw new Error("Selected OpenFGA model is unavailable");
      const body = await response.json() as { authorization_model?: SelectedModel };
      if (body.authorization_model?.id !== id || !Array.isArray(body.authorization_model.type_definitions)) {
        throw new Error("Selected OpenFGA model response is invalid");
      }
      if (installedAuthorizationModules.length && !authorizationModelsEqual(body.authorization_model, bundledAuthorizationModel)) {
        throw new Error("OpenFGA model differs from the compiled host artifact");
      }
      return body.authorization_model;
    })();
    cached = { key, model };
    model.catch(() => { if (cached?.model === model) cached = undefined; });
  }
  return cached!.model;
}

/** Module metadata establishes schema custody. It grants no resource access. */
export async function nativeResourceDefinition(typeName: string) {
  try {
    const compiledType = (bundledAuthorizationModel.type_definitions as ModelType[]).find((type) => type.type === typeName);
    const bundled = installedAuthorizationModules.find((entry) => entry.module === compiledType?.metadata?.module);
    if (!bundled) throw new HttpAuthzError(400, "INVALID_REQUEST", "Resource type is not defined by a bundled extension");
    const model = await selectedModel();
    const definition = model.type_definitions.find((candidate) => candidate.type === typeName);
    if (!isNativeResourceType(typeName) || !definition?.metadata?.module) {
      throw new HttpAuthzError(400, "INVALID_REQUEST", "Resource type is not part of an approved application module");
    }
    const installation = loadConfiguredAgenticApps().find((app) =>
      app.installation.appId === bundled.appId && app.manifest.authorization?.module === bundled.module && app.manifest.version === bundled.version);
    if (!installation) throw new HttpAuthzError(403, "FORBIDDEN", "Resource module has no installed application");
    return { definition, modelId: model.id, appId: installation.installation.appId,
      app: resourceApp(installation.installation.appId) };
  } catch (error) {
    if (error instanceof HttpAuthzError) throw error;
    console.warn("[cas/model] Model unavailable", { name: error instanceof Error ? error.name : "UnknownError" });
    throw new HttpAuthzError(503, "AUTHZ_UNAVAILABLE", "Selected authorization model is unavailable");
  }
}

export async function requireNativePermission(type: string, permission: string): Promise<void> {
  const { definition } = await nativeResourceDefinition(type);
  if (!Object.hasOwn(definition.relations ?? {}, permission)) {
    throw new HttpAuthzError(400, "INVALID_REQUEST", "Permission is not defined on this resource type");
  }
}

/** Only direct principal grants with an explicit per-relationship authority gate. */
export async function nativeGrantRelation(type: string, relation: string, principal: string): Promise<string> {
  const { definition } = await nativeResourceDefinition(type);
  const authority = `can_grant_${relation}`;
  const refs = definition.metadata?.relations?.[relation]?.directly_related_user_types ?? [];
  const permitted = refs.some((ref) => !ref.condition &&
    (principal === "everyone" ? ref.type === "user" && !!ref.wildcard :
      ref.type === principal && (principal === "team" ? ref.relation === "member" : !ref.relation && !ref.wildcard)));
  if (relation === "owner" || relation.startsWith("can_") || !permitted ||
    !Object.hasOwn(definition.relations ?? {}, authority)) {
    throw new HttpAuthzError(400, "INVALID_REQUEST", "Relationship is not writable through the grant API");
  }
  return authority;
}

/** Installation activation is tied to the exact deployment-selected model. */
export async function validateNativeInstallations(): Promise<void> {
  // Validate the compiled contract locally. Deployment may still be publishing
  // the artifact in its post-install job; protected requests fail closed until ready.
  for (const { manifest, installation } of loadConfiguredAgenticApps()) {
    if (!installation.installed || !manifest.authorization) continue;
    if (!installedAuthorizationModules.some((entry) => entry.appId === installation.appId &&
      entry.module === manifest.authorization!.module && entry.version === manifest.version)) {
      throw new Error("Authorization declarations must come from the compiled extension registry");
    }
  }
}

/** Admin inventory uses the same selected schema as authorization. */
export async function listNativeResourceTypeDefinitions() {
  if (!installedAuthorizationModules.length) return [];
  return (await selectedModel()).type_definitions.filter((type) =>
    isNativeResourceType(type.type) && type.metadata?.module).map((type) => ({
      type: type.type, actions: Object.keys(type.relations ?? {}), description: `Application module: ${type.metadata!.module}`,
    }));
}
