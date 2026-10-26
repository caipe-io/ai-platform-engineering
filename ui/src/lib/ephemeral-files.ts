/** Extensions that can be previewed inline instead of forcing a download. */
export const PREVIEWABLE_FILE_EXTENSIONS = [".md", ".txt"] as const;

export function isPreviewableEphemeralFile(path: string): boolean {
  const lower = path.toLowerCase();
  return PREVIEWABLE_FILE_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

export async function fetchEphemeralFileContent(
  fsNamespace: string,
  path: string,
): Promise<string | null> {
  const response = await fetch(
    `/api/files/content?fs_namespace=${encodeURIComponent(fsNamespace)}&path=${encodeURIComponent(path)}`,
  );
  if (!response.ok) return null;
  const data = (await response.json()) as { content?: unknown; encoding?: unknown };
  if (data.encoding === "base64") return null;
  return typeof data.content === "string" ? data.content : "";
}


/** Preserve binary workspace artifacts; legacy text responses remain UTF-8. */
export function fileContentBlob(data: { content?: string; encoding?: string }): Blob {
  if (data.encoding === "base64") {
    return new Blob([Uint8Array.from(atob(data.content ?? ""), byte => byte.charCodeAt(0))], { type: "application/octet-stream" });
  }
  return new Blob([data.content ?? ""], { type: "text/plain;charset=utf-8" });
}
