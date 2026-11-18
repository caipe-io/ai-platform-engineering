import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { validateInventory } from "./validate-regression-inventory.mjs";

const matrix = "docs/docs/development/caipe-regression-suite.md";
const inventory = "docs/docs/development/caipe-regression-screen-coverage.md";
const validInventory = [
  "| SCR-001 | `/` | AUTH-01 | Allowed | Denied |",
  "| APIF-001 | `/api/example` | AUTH-01 |",
].join("\n");

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "regression-inventory-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const write = (path, content = "") => {
    const target = join(root, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  };
  write(matrix, "| AUTH-01 | core | Session policy |\n");
  write(inventory, validInventory);
  write("ui/src/app/(workspace)/page.tsx");
  write("ui/src/app/api/example/[id]/route.ts");
  return { root, write };
}

test("normalizes route groups and matches nested API handlers to families", (t) => {
  const { root, write } = fixture(t);
  write(matrix, "| AUTH-01 | core | Session policy |\n| AUTH-01 | Example result | NOT_RUN | Pending | None |\n");
  assert.deepEqual(validateInventory(root), { errors: [], cases: 1, routes: 1, families: 1 });
});

test("rejects an added page until the inventory maps it", (t) => {
  const { root, write } = fixture(t);
  write("ui/src/app/(workspace)/example/[id]/page.tsx");
  assert.match(validateInventory(root).errors.join("\n"), /missing inventory entry \/example\/\[id\]/);
  write(inventory, `${validInventory}\n| SCR-002 | \`/example/[id]\` | AUTH-01 | Allowed | Denied |`);
  assert.deepEqual(validateInventory(root).errors, []);
});

test("rejects removed routes and newly introduced API families", (t) => {
  const { root, write } = fixture(t);
  write("ui/src/app/api/secondary/route.ts");
  write(inventory, `${validInventory}\n| SCR-002 | \`/removed\` | AUTH-01 | Allowed | Denied |`);
  const errors = validateInventory(root).errors.join("\n");
  assert.match(errors, /missing inventory entry \/api\/secondary/);
  assert.match(errors, /stale inventory entry \/removed/);
});

test("rejects undefined references and duplicate route or case definitions", (t) => {
  const { root, write } = fixture(t);
  write(inventory, `${validInventory}\n| SCR-001 | \`/\` | MISSING-01 | Allowed | Denied |`);
  write(matrix, "| AUTH-01 | core | Session policy |\n| AUTH-01 | core | Duplicate |\n");
  const errors = validateInventory(root).errors.join("\n");
  assert.match(errors, /duplicate case IDs/);
  assert.match(errors, /duplicate ID SCR-001/);
  assert.match(errors, /duplicate path \//);
  assert.match(errors, /undefined feature case MISSING-01/);
});

test("rejects malformed table rows instead of silently ignoring assertions", (t) => {
  const { root, write } = fixture(t);
  write(inventory, validInventory.replace(" | Denied", ""));
  assert.throws(() => validateInventory(root), /expected 5 table columns/);
});

test("keeps detailed assertion IDs unique and tied to a defined feature case", (t) => {
  const { root, write } = fixture(t);
  write(inventory, `${validInventory}\n| AUTH-01.01 | Step | Expected |`);
  assert.deepEqual(validateInventory(root).errors, []);
  write(inventory, `${validInventory}\n| AUTH-01.01 | Step | Expected |\n| AUTH-01.01 | Step | Expected |\n| MISSING-01.01 | Step | Expected |`);
  const errors = validateInventory(root).errors.join("\n");
  assert.match(errors, /duplicate assertion AUTH-01.01/);
  assert.match(errors, /undefined parent case MISSING-01.01/);
});
