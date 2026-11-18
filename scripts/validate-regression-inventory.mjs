#!/usr/bin/env node
/** Check source coverage in the maintained regression inventory; no target calls. */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const matrixPath = "docs/docs/development/caipe-regression-suite.md";
const inventoryPath = "docs/docs/development/caipe-regression-screen-coverage.md";

function filesUnder(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    return entry.isDirectory() ? filesUnder(path) : [path];
  });
}

function tableRows(markdown, prefix, columnCount) {
  return markdown.split("\n").flatMap((line) => {
    if (!new RegExp(`^\\| ${prefix}-\\d+ \\|`).test(line)) return [];
    const cells = line.split("|").slice(1, -1).map((cell) => cell.trim());
    if (cells.length !== columnCount) {
      throw new Error(`${cells[0]}: expected ${columnCount} table columns`);
    }
    return [cells];
  });
}

function compareRows(rows, sourcePaths, knownCases, label) {
  const errors = [];
  const ids = new Set();
  const paths = new Set();
  for (const [id, literalPath, references] of rows) {
    const path = literalPath.replace(/^`|`$/g, "");
    if (ids.has(id)) errors.push(`${label}: duplicate ID ${id}`);
    if (paths.has(path)) errors.push(`${label}: duplicate path ${path}`);
    ids.add(id);
    paths.add(path);
    const cases = references.split(",").map((item) => item.trim());
    for (const caseId of cases) {
      if (!knownCases.has(caseId)) errors.push(`${id}: undefined feature case ${caseId || "(empty)"}`);
    }
  }
  for (const path of sourcePaths) {
    if (!paths.has(path)) errors.push(`${label}: missing inventory entry ${path}`);
  }
  for (const path of paths) {
    if (!sourcePaths.has(path)) errors.push(`${label}: stale inventory entry ${path}`);
  }
  return errors;
}

export function validateInventory(root) {
  const matrix = readFileSync(resolve(root, matrixPath), "utf8");
  const inventory = readFileSync(resolve(root, inventoryPath), "utf8");
  // Acceptance tables have three columns; run-report examples are references.
  const featureIds = matrix.split("\n").flatMap((line) => {
    const cells = line.split("|").slice(1, -1).map((cell) => cell.trim());
    return cells.length === 3 && /^[A-Z]+-\d+$/.test(cells[0]) ? [cells[0]] : [];
  });
  const knownCases = new Set(featureIds);
  const errors = [];
  if (!featureIds.length) errors.push("Feature matrix has no case definitions");
  if (knownCases.size !== featureIds.length) errors.push("Feature matrix has duplicate case IDs");
  const assertionIds = new Set();
  for (const match of inventory.matchAll(/^\| ([A-Z]+-\d+\.\d+) \|/gm)) {
    const id = match[1];
    if (assertionIds.has(id)) errors.push(`Detailed register: duplicate assertion ${id}`);
    assertionIds.add(id);
    if (!knownCases.has(id.split(".")[0])) errors.push(`Detailed register: undefined parent case ${id}`);
  }
  const appRoot = resolve(root, "ui/src/app");
  const apiRoot = resolve(appRoot, "api");
  const files = filesUnder(appRoot);
  const pages = files.filter((path) => path.endsWith(`${sep}page.tsx`));
  const routes = new Set(pages.map((path) => {
    const parts = relative(appRoot, dirname(path)).split(sep)
      .filter((part) => part && !/^\([^)]*\)$/.test(part));
    return `/${parts.join("/")}`;
  }));
  if (routes.size !== pages.length) errors.push("Source contains duplicate normalized page routes");
  const families = new Set(files
    .filter((path) => path.startsWith(`${apiRoot}${sep}`) && path.endsWith(`${sep}route.ts`))
    .map((path) => `/api/${relative(apiRoot, path).split(sep)[0]}`));
  const screens = tableRows(inventory, "SCR", 5);
  const api = tableRows(inventory, "APIF", 3);
  errors.push(...compareRows(screens, routes, knownCases, "Page routes"));
  errors.push(...compareRows(api, families, knownCases, "API families"));
  return { errors, cases: knownCases.size, routes: routes.size, families: families.size };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    const result = validateInventory(root);
    if (result.errors.length) {
      console.error(result.errors.join("\n"));
      process.exitCode = 1;
    } else {
      console.log(`Inventory valid: ${result.cases} feature groups, ${result.routes} page routes, ${result.families} API families. Functional tests were not executed.`);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
