// Test double for the user_settings collection. It enforces what the real
// store enforces and the preference update depends on: a unique user_id, and
// filters that must match for an update to apply. Lives outside __tests__ so
// Jest does not treat it as a suite.

type Doc = Record<string, unknown> & { user_id: string };
type Filter = Record<string, unknown>;

export class DuplicateKeyError extends Error {
  code = 11000;
}

export function createFakeUserSettings(options: { beforeFindResolves?: () => Promise<void> } = {}) {
  const docs = new Map<string, Doc>();

  function matches(doc: Doc, filter: Filter): boolean {
    return Object.entries(filter).every(([key, expected]) => {
      if (key === "$or") {
        return (expected as Filter[]).some((clause) => matches(doc, clause));
      }
      const actual = doc[key];
      if (expected && typeof expected === "object" && "$exists" in (expected as object)) {
        return (actual !== undefined) === (expected as { $exists: boolean }).$exists;
      }
      return actual === expected;
    });
  }

  return {
    docs,
    collection: {
      async findOne(filter: Filter): Promise<Doc | null> {
        const snapshot = docs.get(filter.user_id as string);
        const copy = snapshot ? (JSON.parse(JSON.stringify(snapshot)) as Doc) : null;
        // Lets a test hold every reader here, so two writers read the same revision.
        await options.beforeFindResolves?.();
        return copy;
      },
      async updateOne(filter: Filter, update: { $set: Record<string, unknown> }, opts?: { upsert?: boolean }) {
        const existing = docs.get(filter.user_id as string);
        if (existing) {
          if (matches(existing, filter)) {
            docs.set(existing.user_id, { ...existing, ...update.$set });
            return { matchedCount: 1, upsertedCount: 0 };
          }
          // Filter missed an existing document. An upsert then tries to insert
          // a second user_id, which the unique index rejects.
          if (opts?.upsert) throw new DuplicateKeyError("E11000 duplicate key");
          return { matchedCount: 0, upsertedCount: 0 };
        }
        if (opts?.upsert) {
          docs.set(filter.user_id as string, { user_id: filter.user_id as string, ...update.$set });
          return { matchedCount: 0, upsertedCount: 1 };
        }
        return { matchedCount: 0, upsertedCount: 0 };
      },
    },
  };
}
