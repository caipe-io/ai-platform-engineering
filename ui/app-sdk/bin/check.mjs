#!/usr/bin/env node
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

import {
  CHECKER_VERSION,
  readPackageManifest,
  validateBuiltArtifact,
  validateManifest,
  validatePackage,
} from "../checker.mjs";

const packageRoot = resolve(process.argv[2] ?? ".");
const declaration = readPackageManifest(packageRoot);
const manifest = validateManifest(packageRoot, declaration);
const pkg = validatePackage(packageRoot, manifest);
if (declaration.apiVersion === "2.0" && (declaration.version !== pkg.version || !declaration.ui.profiles.some((profile) => profile.mode === "native-package" && profile.package === pkg.name))) {
  throw new Error(`${pkg.name}: application version/package must match the artifact`);
}
for (const field of [".", "./manifest", "./styles.css"]) {
  const target = pkg.exports[field];
  if (!target.startsWith("./") || !existsSync(join(packageRoot, target))) {
    throw new Error(`${pkg.name}: export ${field} does not point to a built file`);
  }
}
const sizes = validateBuiltArtifact(packageRoot, pkg);
process.stdout.write(`${pkg.name}@${pkg.version} conforms to CAIPE native extension ${manifest.contractVersion} (SDK ${CHECKER_VERSION}; entry ${sizes.entryBytes} B; JavaScript ${sizes.javascriptBytes} B)\n`);
