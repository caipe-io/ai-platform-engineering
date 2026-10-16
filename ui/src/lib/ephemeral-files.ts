/** Extensions that can be previewed inline instead of forcing a download. */
export const PREVIEWABLE_FILE_EXTENSIONS = [".md", ".txt"] as const;

export function isPreviewableEphemeralFile(path: string): boolean {
  const lower = path.toLowerCase();
  return PREVIEWABLE_FILE_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

interface EphemeralFileContent {
  content?: unknown;
  encoding?: unknown;
}

/** Decode the canonical file record without turning binary downloads into text. */
export function ephemeralFileBlob(value: EphemeralFileContent): Blob {
  if (typeof value.content !== "string") throw new Error("Invalid file content");
  if (value.encoding === "base64") {
    if (value.content.length > 4 * Math.ceil(512 * 1024 / 3) ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.content)) {
      throw new Error("Invalid binary file content");
    }
    const decoded = atob(value.content);
    if (decoded.length > 512 * 1024 || btoa(decoded) !== value.content) throw new Error("Invalid binary file content");
    return new Blob([Uint8Array.from(decoded, (char) => char.charCodeAt(0))], { type: "application/octet-stream" });
  }
  if (value.encoding !== undefined && value.encoding !== "utf-8") throw new Error("Unsupported file encoding");
  return new Blob([value.content], { type: "text/plain;charset=utf-8" });
}

export async function fetchEphemeralFileContent(
  fsNamespace: string,
  path: string,
): Promise<string | null> {
  const response = await fetch(
    `/api/files/content?fs_namespace=${encodeURIComponent(fsNamespace)}&path=${encodeURIComponent(path)}`,
  );
  if (!response.ok) return null;
  const data = (await response.json()) as EphemeralFileContent;
  if (data.encoding && data.encoding !== "utf-8") return null;
  return typeof data.content === "string" ? data.content : "";
}
