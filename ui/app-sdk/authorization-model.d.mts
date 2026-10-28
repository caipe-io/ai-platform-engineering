export function normalizeAuthorizationModel(model: unknown, options?: { provenance?: boolean }): Record<string, unknown>;
export function authorizationModelsEqual(left: unknown, right: unknown): boolean;
export function validateAuthorizationComposition(model: unknown, core: unknown, modules: string[]): void;
