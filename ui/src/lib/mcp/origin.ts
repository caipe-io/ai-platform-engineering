/** URLs advertised to MCP clients and used for credential-bearing BFF calls. */
function configuredOrigin(value: string | undefined, name: string): string {
  if (!value) throw new Error(`${name} must be configured when Platform MCP is enabled`);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be an absolute HTTP(S) origin`);
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    !url.hostname ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error(`${name} must be an absolute HTTP(S) origin`);
  }
  return url.origin;
}

export function publicMcpOrigin(): string {
  return configuredOrigin(process.env.NEXTAUTH_URL, "NEXTAUTH_URL");
}

export function internalMcpOrigin(): string {
  return process.env.CAIPE_MCP_INTERNAL_ORIGIN
    ? configuredOrigin(process.env.CAIPE_MCP_INTERNAL_ORIGIN, "CAIPE_MCP_INTERNAL_ORIGIN")
    : publicMcpOrigin();
}
