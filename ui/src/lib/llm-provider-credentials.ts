export type ProviderField = {
  id: string;
  label: string;
  secretType: "api_key" | "custom";
  placeholder?: string;
  required?: boolean;
  inputType?: "url";
  help?: string;
};
export type ProviderDefinition = {
  id: string;
  name: string;
  description: string;
  fields: ProviderField[];
  deploymentHelp?: string;
  legacyIds?: string[];
};
export type ProviderSecretBindings = Record<string, Record<string, string>>;
export type SavedProviderSecret = {
  id: string;
  name: string;
  type: string;
  maskedPreview?: string;
};

export const LLM_PROVIDERS: ProviderDefinition[] = [
  {
    id: "openai",
    name: "OpenAI / Compatible",
    description:
      "OpenAI and any OpenAI-compatible endpoint, including model gateways and self-hosted services.",
    fields: [
      {
        id: "endpoint",
        label: "OpenAI Endpoint URL",
        secretType: "custom",
        inputType: "url",
        required: true,
        placeholder: "https://api.example.com/v1",
        help: "Any OpenAI-compatible endpoint is supported. Use its API base URL, including /v1 when required.",
      },
      {
        id: "api_key",
        label: "API Key",
        secretType: "api_key",
        required: true,
        placeholder: "Enter your API key",
      },
    ],
  },
  {
    id: "anthropic-claude",
    name: "Anthropic Claude",
    description: "Claude models through the Anthropic API.",
    fields: [
      {
        id: "api_key",
        label: "API Key",
        secretType: "api_key",
        required: true,
        placeholder: "Enter your API key",
      },
    ],
  },
  {
    id: "azure-openai",
    name: "Azure OpenAI",
    description: "OpenAI models hosted on Azure deployments.",
    fields: [
      {
        id: "endpoint",
        label: "Azure Endpoint URL",
        secretType: "custom",
        inputType: "url",
        required: true,
        placeholder: "https://resource.example.com/",
      },
      {
        id: "api_version",
        label: "API Version",
        secretType: "custom",
        required: true,
        placeholder: "Enter the supported API version",
      },
      {
        id: "api_key",
        label: "API Key",
        secretType: "api_key",
        required: true,
      },
    ],
  },
  {
    id: "aws-bedrock",
    name: "AWS Bedrock",
    description:
      "Foundation models through AWS Bedrock. Deployment IAM credentials can be used without saving access keys here.",
    fields: [
      { id: "access_key_id", label: "Access Key ID", secretType: "custom" },
      {
        id: "secret_access_key",
        label: "Secret Access Key",
        secretType: "api_key",
      },
      {
        id: "session_token",
        label: "Session Token (optional)",
        secretType: "api_key",
      },
      {
        id: "region",
        label: "Region",
        secretType: "custom",
        placeholder: "Enter the deployment’s AWS region",
      },
    ],
  },
  {
    id: "google-gemini",
    legacyIds: ["google-genai"],
    name: "Google Gemini",
    description: "Gemini models through Google AI APIs.",
    fields: [
      {
        id: "api_key",
        label: "API Key",
        secretType: "api_key",
        required: true,
      },
    ],
  },
  {
    id: "groq",
    name: "Groq",
    description: "Models through the Groq API.",
    fields: [
      {
        id: "api_key",
        label: "API Key",
        secretType: "api_key",
        required: true,
      },
    ],
  },
  {
    id: "gcp-vertexai",
    name: "Google Vertex AI",
    description: "Models through Google Cloud Vertex AI.",
    fields: [],
    deploymentHelp:
      "Vertex AI uses Application Default Credentials configured on the runtime. Ask your deployment administrator to configure its Google Cloud identity, project, and location. An API key is not used for this provider.",
  },
];

export function providerSecretName(provider: string, field: string): string {
  return `llm:${provider}:${field}`;
}

export function providerFieldAcceptsSecret(
  field: ProviderField,
  secret: SavedProviderSecret,
): boolean {
  return field.secretType === "api_key"
    ? ["api_key", "bearer_token", "custom"].includes(secret.type)
    : secret.type === "custom";
}

/** Keep old named entries usable without guessing between duplicate names. */
export function providerBindingsWithLegacySecrets(
  bindings: ProviderSecretBindings,
  secrets: SavedProviderSecret[],
): ProviderSecretBindings {
  const result = { ...bindings };
  for (const provider of LLM_PROVIDERS) {
    if (Object.hasOwn(result, provider.id)) continue;
    const fields: Record<string, string> = {};
    for (const field of provider.fields) {
      const matches = secrets.filter(
        (secret) =>
          [provider.id, ...(provider.legacyIds ?? [])].some(
            (id) => secret.name === providerSecretName(id, field.id),
          ) && providerFieldAcceptsSecret(field, secret),
      );
      if (matches.length === 1) fields[field.id] = matches[0].id;
    }
    result[provider.id] = fields;
  }
  return result;
}

export function normalizeProviderSecretBindings(
  value: unknown,
): ProviderSecretBindings {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result: ProviderSecretBindings = {};
  for (const provider of LLM_PROVIDERS) {
    const source = (value as Record<string, unknown>)[provider.id];
    if (!source || typeof source !== "object" || Array.isArray(source))
      continue;
    result[provider.id] = Object.fromEntries(
      provider.fields.flatMap((field) => {
        const id = (source as Record<string, unknown>)[field.id];
        return typeof id === "string" && id.trim()
          ? [[field.id, id.trim()]]
          : [];
      }),
    );
  }
  return result;
}
