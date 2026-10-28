/** Canonical API representation: ignore default-empty fields, retain policy and provenance. */
export function normalizeAuthorizationModel(model, { provenance = true } = {}) {
  function clean(value, context) {
    if (Array.isArray(value)) return value.map((item) => clean(item));
    if (!value || typeof value !== "object") return value;
    const result = Object.create(null);
    for (const key of Object.keys(value).sort()) {
      if (key === "source_info" && context === "metadata" && !provenance) continue;
      let item = clean(value[key], key);
      if (key === "metadata" && item?.relations) {
        item.relations = Object.fromEntries(Object.entries(item.relations).filter(([, info]) => Object.keys(info).length));
        if (!Object.keys(item.relations).length) delete item.relations;
      }
      if (["conditions", "metadata", "relations", "source_info", "directly_related_user_types"].includes(key) &&
          (!item || Object.keys(item).length === 0)) continue;
      if (["module", "file", "condition", "object"].includes(key) && item === "") continue;
      if (key === "directly_related_user_types") item.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b), "en"));
      result[key] = item;
    }
    return result;
  }
  const result = clean(model);
  delete result.id;
  result.type_definitions = [...(result.type_definitions ?? [])].sort((a, b) => a.type.localeCompare(b.type, "en"));
  return result;
}
export function authorizationModelsEqual(left, right) {
  return JSON.stringify(normalizeAuthorizationModel(left)) === JSON.stringify(normalizeAuthorizationModel(right));
}

/** Model semantics remain OpenFGA's; the host protects its composition boundary. */
export function validateAuthorizationComposition(model, core, modules) {
  const normalized = normalizeAuthorizationModel(model);
  const coreModel = normalizeAuthorizationModel(core);
  const types = new Map(normalized.type_definitions.map((type) => [type.type, type]));
  const coreTypes = new Set(coreModel.type_definitions.map((type) => type.type));
  if (types.size !== normalized.type_definitions.length) throw new Error("Duplicate OpenFGA type");
  const strip = (value, context) => Array.isArray(value) ? value.map((item) => strip(item)) : value && typeof value === "object"
    ? Object.fromEntries(Object.entries(value).filter(([key]) => context !== "metadata" || !["module", "source_info"].includes(key)).map(([key, item]) => [key, strip(item, key)])) : value;
  for (const expected of coreModel.type_definitions) {
    if (!types.has(expected.type) || !authorizationModelsEqual({ type_definitions: [strip(expected)] },
      { type_definitions: [strip(types.get(expected.type))] })) throw new Error(`Bundled policy changes core type ${expected.type}`);
  }
  for (const type of types.values()) {
    if (coreTypes.has(type.type)) continue;
    const moduleName = type.metadata?.module;
    if (!modules.includes(moduleName)) throw new Error(`Unbundled authorization module for ${type.type}`);
    for (const metadata of Object.values(type.metadata?.relations ?? {})) {
      if (metadata.module && metadata.module !== moduleName) throw new Error(`Cross-module relation extension on ${type.type}`);
    }
  }
  for (const [name, condition] of Object.entries(coreModel.conditions ?? {})) {
    if (JSON.stringify(strip(condition)) !== JSON.stringify(strip(normalized.conditions?.[name]))) throw new Error(`Bundled policy changes core condition ${name}`);
  }
  for (const [name, condition] of Object.entries(normalized.conditions ?? {})) {
    if (!coreModel.conditions?.[name] && !modules.includes(condition.metadata?.module)) throw new Error(`Unbundled condition ${name}`);
  }
  for (const moduleName of modules) {
    if (![...types.values()].some((type) => !coreTypes.has(type.type) && type.metadata?.module === moduleName)) {
      throw new Error(`Bundled module ${moduleName} defines no resource type`);
    }
  }
}
