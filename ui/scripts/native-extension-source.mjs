import { dirname, relative, sep } from "node:path";

export function tailwindSourceForEntry(stylesFile, entryFile) {
  return relative(dirname(stylesFile), dirname(entryFile)).split(sep).join("/");
}
