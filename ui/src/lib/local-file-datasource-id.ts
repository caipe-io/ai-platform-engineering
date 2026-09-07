import { createHash } from "node:crypto";

export interface LocalUploadFile {
  name: string;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export function localUploadFilename(value: string): string {
  const candidate = value.trim().split(/[\\/]/).at(-1) ?? "";
  return candidate || "uploaded-file";
}

function localUploadStem(value: string, maximumLength: number): string {
  const stem = value.includes(".")
    ? value.slice(0, value.lastIndexOf("."))
    : value;
  const clean = Array.from(stem.toLowerCase())
    .map((character) => (/^[a-z0-9]$/.test(character) ? character : "_"))
    .join("")
    .replace(/^_+|_+$/g, "");
  return (clean || "upload").slice(0, maximumLength);
}

/**
 * Mirror the RAG server's deterministic content-addressed batch id.
 * Keep this byte-for-byte compatible with `_local_files_datasource_id`.
 */
export async function computeLocalFileDatasourceId(
  files: readonly LocalUploadFile[],
): Promise<string> {
  if (files.length === 0) {
    throw new Error("At least one file is required");
  }
  const digest = createHash("sha256");
  const names: string[] = [];
  for (const file of files) {
    const filename = localUploadFilename(file.name);
    names.push(filename);
    const content = Buffer.from(await file.arrayBuffer());
    digest.update(filename, "utf8");
    digest.update(Buffer.from([0]));
    digest.update(createHash("sha256").update(content).digest("hex"), "ascii");
    digest.update(Buffer.from([0]));
  }
  const suffix = digest.digest("hex").slice(0, 12);
  if (names.length === 1) {
    return `src_file_${localUploadStem(names[0], 80)}_${suffix}`;
  }
  return `src_file_${localUploadStem(names[0], 64)}_${files.length}_files_${suffix}`;
}
