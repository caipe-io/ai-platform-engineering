/** Git refs accepted by the compare endpoint, without URL/expression syntax. */
export function isValidReleaseNotesRef(value: string): boolean {
  const ref = value.trim();
  if (!ref || ref.length > 256 || ref === "@") return false;
  if (/[\x00-\x20\x7f~^:?*[\\#%]/.test(ref)) return false;
  if (ref.includes("..") || ref.includes("@{")) return false;
  return ref.split("/").every((part) =>
    Boolean(part) && !part.startsWith(".") && !part.endsWith(".") && !part.endsWith(".lock"),
  );
}

/** Only ordinary GitHub owner/repository coordinates; never credentials/ports. */
export function parseReleaseNotesRepository(value: string): { owner: string; repository: string } | null {
  try {
    const url = new URL(value);
    const parts = url.pathname.replace(/\.git\/?$/i, "").split("/").filter(Boolean);
    if (url.protocol !== "https:" || url.hostname !== "github.com" || url.port ||
        url.username || url.password || url.search || url.hash || parts.length !== 2 ||
        !/^[a-z\d](?:[a-z\d-]{0,38})$/i.test(parts[0]) ||
        !/^[a-z\d_.-]{1,100}$/i.test(parts[1]) || [".", ".."].includes(parts[1])) return null;
    return { owner: parts[0], repository: parts[1] };
  } catch {
    return null;
  }
}
