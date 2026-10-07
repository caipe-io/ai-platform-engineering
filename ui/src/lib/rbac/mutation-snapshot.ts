/** Match the document used to calculate a permission diff, not a newer save. */
export function mutationSnapshotFilter(id: string, snapshot: object | null): Record<string, unknown> {
  const document = (snapshot ?? {}) as Record<string, unknown>;
  return {
    _id: id,
    updated_at: Object.hasOwn(document, "updated_at") ? document.updated_at : { $exists: false },
    // A unique token also detects two updates within the same millisecond.
    authz_write_id: Object.hasOwn(document, "authz_write_id") ? document.authz_write_id : { $exists: false },
  };
}
