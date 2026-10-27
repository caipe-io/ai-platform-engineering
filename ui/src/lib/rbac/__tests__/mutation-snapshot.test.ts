import { mutationSnapshotFilter } from "../mutation-snapshot";

it("matches legacy documents without treating null as a missing version", () => {
  expect(mutationSnapshotFilter("example", {})).toEqual({ _id: "example", updated_at: { $exists: false }, authz_write_id: { $exists: false } });
  expect(mutationSnapshotFilter("example", { updated_at: null })).toEqual({ _id: "example", updated_at: null, authz_write_id: { $exists: false } });
});

it("rejects a stale snapshot even when two saves share a timestamp", () => {
  const old = { updated_at: "2026-01-01", authz_write_id: "first" };
  const next = { ...old, authz_write_id: "second" };
  expect(mutationSnapshotFilter("example", old)).not.toEqual(mutationSnapshotFilter("example", next));
});
