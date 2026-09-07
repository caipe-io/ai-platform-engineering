/**
 * `source_id` formulas for RAG ingestion sources (spec
 * 2026-07-21-rag-source-config-db). Each formula is a TS port of the
 * matching Python ingestor's `datasource_id` derivation, so a source
 * created here lands on the same id the ingestor will compute in PR3 — see
 * docs/docs/specs/2026-07-21-rag-source-config-db/data-model.md for the
 * source-of-truth table.
 *
 * `jira_project` is a deliberate deviation: the real ingestor
 * (`ingestors/src/ingestors/jira/ingestor.py`) slugifies the mutable
 * `name` field, which orphans tuples on rename. This store instead requires
 * an immutable, caller-supplied `source_slug`.
 */

import { createHash } from "crypto";

/** Identity fields needed to derive a `source_id`, keyed by `source_type`. */
export type IngestionSourceIdentity =
  | { source_type: "slack_channel"; channel_id: string }
  | {
      source_type: "confluence_space";
      confluence_url: string;
      space_key: string;
      /** Omitted only by legacy whole-space configuration. */
      page_id?: string;
    }
  | { source_type: "jira_project"; project_key: string; source_slug: string }
  | { source_type: "web_url"; url: string }
  | { source_type: "webex_space"; space_id: string };

export function slackChannelSourceId(channelId: string): string {
  return `slack-channel-${channelId}`;
}

/**
 * Extract the URL's netloc (host[:port]) exactly as Python's
 * `urlparse(url).netloc` would — case and port preserved. The WHATWG `URL`
 * API always lowercases the ASCII hostname, which would silently diverge
 * from the Python ingestor's id for any mixed-case or non-default-port host.
 */
function netloc(url: string): string {
  return url.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, "").split(/[/?#]/)[0];
}

function managedSourceId(rawId: string): string {
  const sanitized = rawId.replace(/[^A-Za-z0-9._~@|*+=,/\-]/gu, "_");
  if (sanitized.length <= 192) return sanitized;
  const suffix = createHash("sha256").update(rawId).digest("hex").slice(0, 12);
  return `${sanitized.slice(0, 179)}_${suffix}`;
}

export function confluenceSpaceSourceId(
  confluenceUrl: string,
  spaceKey: string,
  pageId?: string,
): string {
  const domain = netloc(confluenceUrl).replace(/[.-]/g, "_");
  const spaceId = `src_confluence___${domain}__${spaceKey}`;
  // Preserve whole-space IDs from legacy environment configuration. New
  // page-scoped sources must also be valid authorization resource IDs.
  return pageId ? managedSourceId(`${spaceId}__${pageId}`) : spaceId;
}

export function webUrlSourceId(url: string): string {
  const sourceHash = createHash("md5").update(url).digest("hex").slice(0, 12);
  // Matches Python's `c.isalnum()` (Unicode-aware) rather than an ASCII-only
  // class, so non-ASCII letters/digits in the URL clean the same way on
  // both sides.
  const cleanUrl = url.replace(/[^\p{L}\p{N}]/gu, "_");
  return `src_${cleanUrl}_${sourceHash}`;
}

export function webexSpaceSourceId(spaceId: string): string {
  return `webex-space-${spaceId}`;
}

export function jiraProjectSourceId(projectKey: string, sourceSlug: string): string {
  return `jira-${projectKey.toLowerCase()}-${sourceSlug}`;
}

/** Compute the deterministic `source_id` for any discriminated source payload. */
export function computeIngestionSourceId(source: IngestionSourceIdentity): string {
  switch (source.source_type) {
    case "slack_channel":
      return slackChannelSourceId(source.channel_id);
    case "confluence_space":
      return confluenceSpaceSourceId(
        source.confluence_url,
        source.space_key,
        source.page_id,
      );
    case "web_url":
      return webUrlSourceId(source.url);
    case "webex_space":
      return webexSpaceSourceId(source.space_id);
    case "jira_project":
      return jiraProjectSourceId(source.project_key, source.source_slug);
  }
}
