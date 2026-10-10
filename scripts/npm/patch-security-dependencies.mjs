import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const braceBefore = "      stack.push(block);";
export const braceAfter = `      if (stack.length >= 101) {
        throw new SyntaxError('Pattern nesting exceeds maximum depth (100)');
      }
      stack.push(block);`;
export const forgeBefore = "            obj.value.length !== 2) {";
export const forgeAfter = `            obj.value.length !== 2 ||
            obj.value[0].value.length !==
              (('parameters' in capture) ? 2 : 1)) {`;

export function patchSource(source, before, after, expected, label) {
  // Recognize the complete patched form before searching its shared suffix.
  if (source.split(after).length - 1 === expected &&
      !source.split(after).join("").includes(before)) return source;
  if (source.includes(after) || source.split(before).length - 1 !== expected) {
    throw new Error(`Unexpected ${label} source; review the security backport`);
  }
  return source.split(before).join(after);
}

export function patchDependencies(directory = process.cwd()) {
  const lock = JSON.parse(readFileSync(resolve(directory, "package-lock.json"), "utf8"));
  const patches = {
    braces: { version: "3.0.3", file: "lib/parse.js", before: braceBefore, after: braceAfter, count: 2 },
    "node-forge": { version: "1.4.0", file: "lib/rsa.js", before: forgeBefore, after: forgeAfter, count: 1 },
  };
  for (const [packagePath, metadata] of Object.entries(lock.packages)) {
    const name = packagePath.split("node_modules/").at(-1);
    const patch = patches[name];
    if (!patch || !existsSync(resolve(directory, packagePath))) continue;
    if (metadata.version !== patch.version) {
      throw new Error(`Review ${name} ${metadata.version} and remove or update its security backport`);
    }
    const installed = JSON.parse(readFileSync(resolve(directory, packagePath, "package.json"), "utf8"));
    if (installed.name !== name || installed.version !== patch.version) {
      throw new Error(`Unexpected installed ${name} version`);
    }
    const file = resolve(directory, packagePath, patch.file);
    const source = readFileSync(file, "utf8");
    const result = patchSource(source, patch.before, patch.after, patch.count, name);
    if (result !== source) writeFileSync(file, result);
    console.log(`Security backport verified: ${packagePath}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  patchDependencies();
}
