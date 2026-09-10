import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
let enginesPath;

try {
  enginesPath = require.resolve("gray-matter/lib/engines");
} catch (error) {
  if (error?.code === "MODULE_NOT_FOUND") {
    process.exit(0);
  }
  throw error;
}

const source = readFileSync(enginesPath, "utf8");
const patched = source
  .replace("yaml.safeLoad.bind(yaml)", "yaml.load.bind(yaml)")
  .replace("yaml.safeDump.bind(yaml)", "yaml.dump.bind(yaml)");

if (patched !== source) {
  writeFileSync(enginesPath, patched);
} else if (
  !source.includes("yaml.load.bind(yaml)") ||
  !source.includes("yaml.dump.bind(yaml)")
) {
  throw new Error("Unable to patch gray-matter js-yaml engine calls");
}
