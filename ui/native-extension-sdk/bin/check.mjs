#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import {
  CHECKER_VERSION,
  validateBuiltArtifact,
  validateManifest,
  validatePackage,
} from "../checker.mjs";

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
const sizes = validateBuiltArtifact(packageRoot, pkg);
process.stdout.write(`${pkg.name}@${pkg.version} conforms to CAIPE native extension ${manifest.contractVersion} (SDK ${CHECKER_VERSION}; entry ${sizes.entryBytes} B; JavaScript ${sizes.javascriptBytes} B)\n`);
