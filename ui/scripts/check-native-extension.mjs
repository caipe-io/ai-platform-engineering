#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { validateManifest, validatePackage } from "./native-extension-contract.mjs";

const packageRoot = resolve(process.argv[2] ?? ".");
const manifest = JSON.parse(readFileSync(join(packageRoot, "manifest.json"), "utf8"));
validateManifest(packageRoot, manifest);
const pkg = validatePackage(packageRoot, manifest);
for (const field of [".", "./manifest", "./styles.css"]) {
  const target = pkg.exports[field];
  if (!target.startsWith("./") || !existsSync(join(packageRoot, target))) {
    throw new Error(`${pkg.name}: export ${field} does not point to a built file`);
  }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.stdout.write(`${pkg.name}@${pkg.version} conforms to CAIPE native extension ${manifest.contractVersion}\n`);
}
