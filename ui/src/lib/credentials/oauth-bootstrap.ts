import { BUILT_IN_OAUTH_CONNECTORS } from "./built-in-oauth-connectors";
import type { CreateConnectorInput, OAuthConnectorService } from "./oauth-service";

type Env = Record<string, string | undefined>;
type ConfiguredConnector = Record<string, unknown>;

const CONFIGURED_CONNECTORS_ENV = "CREDENTIAL_BOOTSTRAP_OAUTH_CONNECTORS_JSON";

interface BootstrapProviderEnv {
  provider: "amplitude" | "atlassian" | "figma" | "github" | "gitlab" | "linear" | "notion" | "pagerduty" | "webex";
  clientIdEnv: string;
  clientSecretEnv?: string;
  redirectUriEnv: string;
  scopesEnv?: string;
}

const PROVIDER_ENV: BootstrapProviderEnv[] = [
  {
    provider: "amplitude",
    clientIdEnv: "AMPLITUDE_CLIENT_ID",
    clientSecretEnv: "AMPLITUDE_CLIENT_SECRET",
    redirectUriEnv: "AMPLITUDE_REDIRECT_URI",
    scopesEnv: "AMPLITUDE_SCOPES",
  },
  {
    provider: "github",
    clientIdEnv: "GITHUB_CLIENT_ID",
    clientSecretEnv: "GITHUB_CLIENT_SECRET",
    redirectUriEnv: "GITHUB_REDIRECT_URI",
  },
  {
    provider: "atlassian",
    clientIdEnv: "CONFLUENCE_CLIENT_ID",
    clientSecretEnv: "CONFLUENCE_CLIENT_SECRET",
    redirectUriEnv: "CONFLUENCE_REDIRECT_URI",
  },
  {
    provider: "webex",
    clientIdEnv: "WEBEX_CLIENT_ID",
    clientSecretEnv: "WEBEX_CLIENT_SECRET",
    redirectUriEnv: "WEBEX_REDIRECT_URI",
  },
  {
    provider: "pagerduty",
    clientIdEnv: "PAGERDUTY_CLIENT_ID",
    clientSecretEnv: "PAGERDUTY_CLIENT_SECRET",
    redirectUriEnv: "PAGERDUTY_REDIRECT_URI",
    scopesEnv: "PAGERDUTY_SCOPES",
  },
  {
    provider: "gitlab",
    clientIdEnv: "GITLAB_CLIENT_ID",
    clientSecretEnv: "GITLAB_CLIENT_SECRET",
    redirectUriEnv: "GITLAB_REDIRECT_URI",
    scopesEnv: "GITLAB_SCOPES",
  },
  {
    provider: "figma",
    clientIdEnv: "FIGMA_CLIENT_ID",
    clientSecretEnv: "FIGMA_CLIENT_SECRET",
    redirectUriEnv: "FIGMA_REDIRECT_URI",
  },
  {
    provider: "linear",
    clientIdEnv: "LINEAR_CLIENT_ID",
    clientSecretEnv: "LINEAR_CLIENT_SECRET",
    redirectUriEnv: "LINEAR_REDIRECT_URI",
  },
  {
    provider: "notion",
    clientIdEnv: "NOTION_CLIENT_ID",
    clientSecretEnv: "NOTION_CLIENT_SECRET",
    redirectUriEnv: "NOTION_REDIRECT_URI",
  },
];

function enabled(value: string | undefined): boolean {
  return value === "true" || value === "1";
}

function value(env: Env, key: string): string | null {
  const candidate = env[key]?.trim();
  return candidate ? candidate : null;
}

function canonicalCallbackBase(env: Env): string {
  return value(env, "NEXTAUTH_URL") ?? "http://localhost:3000";
}

function canonicalProviderCallback(provider: string, env: Env): string {
  return `${canonicalCallbackBase(env).replace(/\/$/, "")}/api/credentials/oauth/${provider}/callback`;
}

function normalizeRedirectUri(
  provider: string,
  redirectUri: string,
  env: Env,
): string {
  try {
    const url = new URL(redirectUri);
    const legacyLocalCallback =
      (url.hostname === "localhost" || url.hostname === "127.0.0.1") &&
      url.port === "3001" &&
      url.pathname === `/oauth/${provider}/callback`;

    if (legacyLocalCallback) {
      return canonicalProviderCallback(provider, env);
    }
  } catch {
    return redirectUri;
  }

  return redirectUri;
}

function scopesForProvider(
  descriptor: NonNullable<(typeof BUILT_IN_OAUTH_CONNECTORS)[number]>,
  providerEnv: BootstrapProviderEnv,
  env: Env,
): string[] {
  const configured = providerEnv.scopesEnv ? value(env, providerEnv.scopesEnv) : null;
  if (!configured) {
    return descriptor.scopes;
  }
  return configured
    .split(/[,\s]+/)
    .map((scope) => scope.trim())
    .filter(Boolean);
}

function configuredString(
  connector: ConfiguredConnector,
  field: string,
  index: number,
  options: { required?: boolean } = {},
): string | null {
  const candidate = connector[field];
  if (candidate === undefined || candidate === null || candidate === "") {
    if (options.required) {
      throw new Error(`OAuth connector at index ${index} requires ${field}`);
    }
    return null;
  }
  if (typeof candidate !== "string" || !candidate.trim()) {
    throw new Error(`OAuth connector at index ${index} has an invalid ${field}`);
  }
  return candidate.trim();
}

function configuredEnvValue(
  connector: ConfiguredConnector,
  inlineField: string,
  envField: string,
  env: Env,
  index: number,
): string {
  const inlineValue = configuredString(connector, inlineField, index);
  const envName = configuredString(connector, envField, index);
  if (inlineValue && envName) {
    throw new Error(
      `OAuth connector at index ${index} must set only one of ${inlineField} or ${envField}`,
    );
  }
  if (inlineValue) {
    return inlineValue;
  }
  if (!envName) {
    throw new Error(`OAuth connector at index ${index} requires ${inlineField} or ${envField}`);
  }
  const resolved = value(env, envName);
  if (!resolved) {
    throw new Error(
      `OAuth connector at index ${index} references missing environment variable ${envName}`,
    );
  }
  return resolved;
}

function configuredScopes(connector: ConfiguredConnector, index: number): string[] {
  const scopes = connector.scopes;
  if (!Array.isArray(scopes)) {
    throw new Error(`OAuth connector at index ${index} requires scopes to be an array`);
  }
  return scopes.map((scope, scopeIndex) => {
    if (typeof scope !== "string" || !scope.trim()) {
      throw new Error(
        `OAuth connector at index ${index} has an invalid scope at index ${scopeIndex}`,
      );
    }
    return scope.trim();
  });
}

function buildConfiguredOAuthConnectorBootstrapInputs(env: Env): CreateConnectorInput[] {
  const serialized = value(env, CONFIGURED_CONNECTORS_ENV);
  if (!serialized) {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    throw new Error(`${CONFIGURED_CONNECTORS_ENV} must contain valid JSON`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`${CONFIGURED_CONNECTORS_ENV} must contain a JSON array`);
  }

  const providers = new Set<string>();
  return parsed.map((candidate, index) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      throw new Error(`OAuth connector at index ${index} must be an object`);
    }
    const connector = candidate as ConfiguredConnector;
    const provider = configuredString(connector, "provider", index, { required: true })!;
    if (providers.has(provider)) {
      throw new Error(`OAuth connector provider ${provider} is configured more than once`);
    }
    providers.add(provider);

    const pkceValue = connector.pkce;
    if (pkceValue !== undefined && typeof pkceValue !== "boolean") {
      throw new Error(`OAuth connector at index ${index} has an invalid pkce value`);
    }
    const pkce = pkceValue === true;
    const authMethod = connector.tokenEndpointAuthMethod;
    if (
      authMethod !== undefined
      && authMethod !== "client_secret_post"
      && authMethod !== "client_secret_basic"
    ) {
      throw new Error(`OAuth connector at index ${index} has an invalid tokenEndpointAuthMethod`);
    }
    const clientSecretEnv = configuredString(connector, "clientSecretEnv", index);
    let clientSecret: string | undefined;
    if (!pkce) {
      if (!clientSecretEnv) {
        throw new Error(`OAuth connector at index ${index} requires clientSecretEnv`);
      }
      clientSecret = value(env, clientSecretEnv) ?? undefined;
      if (!clientSecret) {
        throw new Error(
          `OAuth connector at index ${index} references missing environment variable ${clientSecretEnv}`,
        );
      }
    }

    const redirectUri = configuredString(connector, "redirectUri", index)
      ?? canonicalProviderCallback(provider, env);
    return {
      name: configuredString(connector, "name", index, { required: true })!,
      provider,
      clientId: configuredEnvValue(connector, "clientId", "clientIdEnv", env, index),
      ...(clientSecret ? { clientSecret } : {}),
      authorizationUrl: configuredString(connector, "authorizationUrl", index, { required: true })!,
      tokenUrl: configuredString(connector, "tokenUrl", index, { required: true })!,
      scopes: configuredScopes(connector, index),
      redirectUri: normalizeRedirectUri(provider, redirectUri, env),
      ...(pkce ? { pkce: true } : {}),
      ...(authMethod === "client_secret_basic" ? { tokenEndpointAuthMethod: authMethod } : {}),
    };
  });
}

export function buildOAuthConnectorBootstrapInputs(env: Env = process.env): CreateConnectorInput[] {
  const legacyInputs: CreateConnectorInput[] = [];
  for (const providerEnv of PROVIDER_ENV) {
    const descriptor = BUILT_IN_OAUTH_CONNECTORS.find(
      (candidate) => candidate.provider === providerEnv.provider,
    );
    const clientId = value(env, providerEnv.clientIdEnv);
    const clientSecret = providerEnv.clientSecretEnv ? value(env, providerEnv.clientSecretEnv) : null;
    const redirectUri = value(env, providerEnv.redirectUriEnv);
    const isPkce = descriptor?.pkce === true;
    if (!descriptor || !clientId || (!isPkce && !clientSecret) || !redirectUri) {
      continue;
    }
    legacyInputs.push({
      name: descriptor.name,
      provider: descriptor.provider,
      clientId,
      ...(clientSecret ? { clientSecret } : {}),
      authorizationUrl: descriptor.authorizationUrl,
      tokenUrl: descriptor.tokenUrl,
      scopes: scopesForProvider(descriptor, providerEnv, env),
      redirectUri: normalizeRedirectUri(providerEnv.provider, redirectUri, env),
      ...(isPkce ? { pkce: true } : {}),
    });
  }
  const configuredInputs = buildConfiguredOAuthConnectorBootstrapInputs(env);
  const configuredProviders = new Set(configuredInputs.map((input) => input.provider));
  return [
    ...legacyInputs.filter((input) => !configuredProviders.has(input.provider)),
    ...configuredInputs,
  ];
}

export async function bootstrapOAuthConnectorsFromEnv(options?: {
  env?: Env;
  service?: Pick<OAuthConnectorService, "upsertConnector">;
}): Promise<number> {
  const env = options?.env ?? process.env;
  const hasConfiguredConnectors = Boolean(value(env, CONFIGURED_CONNECTORS_ENV));
  if (!enabled(env.CREDENTIAL_BOOTSTRAP_OAUTH_CONNECTORS) && !hasConfiguredConnectors) {
    return 0;
  }
  const inputs = buildOAuthConnectorBootstrapInputs(env);
  if (inputs.length === 0) {
    return 0;
  }
  const service = options?.service ?? await (async () => {
    const { getOAuthConnectorService } = await import("./oauth-service-factory");
    return getOAuthConnectorService();
  })();
  let applied = 0;
  for (const input of inputs) {
    try {
      await service.upsertConnector(input);
      applied++;
    } catch (err) {
      const message = err instanceof Error ? err.message : "unknown error";
      console.error(`[credentials] Skipped OAuth connector bootstrap for ${input.provider}: ${message}`);
    }
  }
  if (applied > 0) {
    console.log(`[credentials] Bootstrapped ${applied} OAuth connector(s) from environment`);
  }
  return applied;
}
