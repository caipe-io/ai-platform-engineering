const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const GIT_SHA_PATTERN = /^[0-9a-f]{7,40}$/i;

function normalizedValue(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  if (!normalized || normalized.toLowerCase() === "unknown") return null;
  return normalized;
}

export function formatSemanticVersion(version: string | null | undefined): string | null {
  const normalized = normalizedValue(version)?.replace(/^v/i, "");
  return normalized && SEMVER_PATTERN.test(normalized) ? `v${normalized}` : null;
}

export function formatCommitSha(commit: string | null | undefined): string | null {
  const normalized = normalizedValue(commit);
  return normalized && GIT_SHA_PATTERN.test(normalized) ? normalized.slice(0, 7) : null;
}

export function formatBuildIdentifier(input: {
  version?: string | null;
  packageVersion?: string | null;
  gitCommit?: string | null;
}): string | null {
  const suppliedVersion = normalizedValue(input.version);
  const semanticVersion = formatSemanticVersion(suppliedVersion);
  if (semanticVersion) return semanticVersion;

  const commit = formatCommitSha(input.gitCommit);
  if (suppliedVersion) return commit;

  return formatSemanticVersion(input.packageVersion) ?? commit;
}

export function formatComponentVersion(version: string | null | undefined): string | null {
  const normalized = normalizedValue(version);
  if (!normalized) return null;
  return formatSemanticVersion(normalized) ?? normalized;
}
