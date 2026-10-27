/** Small cursor-response fixture shared by audit browser tests. */
export function auditPage<T>(records: T[], url: URL) {
  const start = Number((url.searchParams.get("cursor") ?? "offset:0").replace("offset:", ""));
  const limit = Number(url.searchParams.get("limit") ?? 30);
  return {
    records: records.slice(start, start + limit),
    cursor: `offset:${start}`,
    next_cursor: start + limit < records.length ? `offset:${start + limit}` : null,
    since: "2026-06-20T00:00:00Z",
    until: "2026-06-21T00:00:00Z",
    as_of: "2026-06-21T00:00:00Z",
    limit,
  };
}
