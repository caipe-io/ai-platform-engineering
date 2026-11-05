/** Preserve Markdown indentation while discarding surrounding blank lines. */
export function trimReleaseMarkdown(value: string): string {
  return value.replace(/^(?:[ \t]*\r?\n)+/, "").trimEnd();
}

/** Parse the metadata and body shared by preview and published release notes. */
export function parseReleaseNotesMarkdown(raw: string): { title: string | null; date: string | null; body: string } {
  let title: string | null = null;
  let date: string | null = null;
  raw = trimReleaseMarkdown(raw);
  let body = raw;

  const frontmatterMatch = raw.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
  if (frontmatterMatch) {
    const frontmatter = frontmatterMatch[1];
    body = raw.slice(frontmatterMatch[0].length);
    const titleMatch = frontmatter.match(/^title:\s*(.+)$/m);
    if (titleMatch) {
      title = titleMatch[1].trim().replace(/^["']|["']$/g, "");
    }
    const dateMatch = frontmatter.match(/^date:\s*(.+)$/m);
    if (dateMatch) {
      date = dateMatch[1].trim().replace(/^["']|["']$/g, "");
    }
  }

  body = trimReleaseMarkdown(body.replace(/<!--\s*truncate\s*-->/g, ""));
  return { title, date, body };
}

