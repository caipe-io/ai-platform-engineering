const MAX_JOB_BATCH_SIZE = 100;
const SUCCESSFUL_JOB_STATUSES = new Set(["completed", "completed_with_errors"]);

export interface RagRequestSession {
  accessToken?: string;
  org?: string;
}

export interface DatasourceIngestionStats {
  documentCount?: number;
  chunkCount?: number;
}

interface RagJobListItem {
  status?: unknown;
  created_at?: unknown;
  document_count?: unknown;
  chunk_count?: unknown;
}

export function getRagServerUrl(): string {
  return (
    process.env.RAG_SERVER_URL ||
    process.env.NEXT_PUBLIC_RAG_URL ||
    "http://localhost:9446"
  );
}

export function ragRequestHeaders(
  session: RagRequestSession,
): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (session.accessToken) headers.Authorization = `Bearer ${session.accessToken}`;
  if (session.org) headers["X-Tenant-Id"] = session.org;
  return headers;
}

function sortableNumber(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function nonNegativeInteger(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && parsed >= 0
    ? Math.trunc(parsed)
    : undefined;
}

/** Load the latest successful ingestion totals for each requested datasource. */
export async function loadLatestSuccessfulIngestionStats(
  session: RagRequestSession,
  datasourceIds: string[],
): Promise<Map<string, DatasourceIngestionStats>> {
  const stats = new Map<string, DatasourceIngestionStats>();
  if (!session.accessToken || datasourceIds.length === 0) return stats;

  const uniqueIds = Array.from(new Set(datasourceIds.filter(Boolean)));
  const batches: string[][] = [];
  for (let index = 0; index < uniqueIds.length; index += MAX_JOB_BATCH_SIZE) {
    batches.push(uniqueIds.slice(index, index + MAX_JOB_BATCH_SIZE));
  }

  const results = await Promise.allSettled(
    batches.map(async (batch) => {
      const response = await fetch(`${getRagServerUrl()}/v1/jobs/batch`, {
        method: "POST",
        headers: ragRequestHeaders(session),
        body: JSON.stringify({
          datasource_ids: batch,
          status_filter: [...SUCCESSFUL_JOB_STATUSES],
        }),
      });
      if (!response.ok) return null;
      return { batch, body: (await response.json()) as unknown };
    }),
  );

  for (const result of results) {
    if (result.status !== "fulfilled" || !result.value) continue;
    const { batch, body } = result.value;
    const jobs = body && typeof body === "object"
      ? (body as { jobs?: unknown }).jobs
      : undefined;
    if (!jobs || typeof jobs !== "object" || Array.isArray(jobs)) continue;

    for (const datasourceId of batch) {
      const candidateJobs = (jobs as Record<string, unknown>)[datasourceId];
      if (!Array.isArray(candidateJobs)) continue;
      const latest = (candidateJobs as RagJobListItem[])
        .filter((job) =>
          typeof job.status === "string" &&
          SUCCESSFUL_JOB_STATUSES.has(job.status),
        )
        .sort(
          (left, right) =>
            sortableNumber(right.created_at) - sortableNumber(left.created_at),
        )[0];
      if (!latest) continue;
      const documentCount = nonNegativeInteger(latest.document_count);
      const chunkCount = nonNegativeInteger(latest.chunk_count);
      if (documentCount === undefined && chunkCount === undefined) continue;
      stats.set(datasourceId, {
        ...(documentCount !== undefined ? { documentCount } : {}),
        ...(chunkCount !== undefined ? { chunkCount } : {}),
      });
    }
  }

  return stats;
}
