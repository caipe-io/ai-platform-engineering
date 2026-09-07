import {
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, extname, join } from "node:path";

const require = createRequire(import.meta.url);
const packageRoot = dirname(dirname(require.resolve("image-size")));
const distRoot = join(packageRoot, "dist");

const replacements = [
  {
    vulnerable: "imageOffset += imageHeader[1];",
    patched:
      "imageOffset += imageHeader[1] > 0 ? imageHeader[1] : 8;",
  },
  {
    vulnerable: "currentOffset = ispeBox.offset + ispeBox.size;",
    patched:
      "currentOffset = ispeBox.offset + (ispeBox.size > 0 ? ispeBox.size : 8);",
  },
  {
    vulnerable: "offset = jxlpBox.offset + jxlpBox.size;",
    patched:
      "offset = jxlpBox.offset + (jxlpBox.size > 0 ? jxlpBox.size : 8);",
  },
];

function sourceFiles(directory) {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) {
      return sourceFiles(path);
    }
    return [".cjs", ".mjs"].includes(extname(path)) ? [path] : [];
  });
}

const replacementCounts = new Map(
  replacements.map(({ vulnerable }) => [vulnerable, 0]),
);
const files = sourceFiles(distRoot);

for (const path of files) {
  const source = readFileSync(path, "utf8");
  let patched = source;

  for (const { vulnerable, patched: safe } of replacements) {
    if (patched.includes(vulnerable)) {
      patched = patched.replaceAll(vulnerable, safe);
      replacementCounts.set(
        vulnerable,
        replacementCounts.get(vulnerable) + 1,
      );
    }
  }

  if (patched !== source) {
    writeFileSync(path, patched);
  }
}

for (const { vulnerable, patched } of replacements) {
  const wasReplaced = replacementCounts.get(vulnerable) > 0;
  const isAlreadyPatched = files.some((path) =>
    readFileSync(path, "utf8").includes(patched),
  );

  if (!wasReplaced && !isAlreadyPatched) {
    throw new Error(`Unable to patch image-size loop: ${vulnerable}`);
  }
}
