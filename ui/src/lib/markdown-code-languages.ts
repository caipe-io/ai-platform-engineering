const LANGUAGE_ALIASES = new Map([
  ["c++", "cpp"],
  ["c#", "csharp"],
  ["f#", "fsharp"],
]);

/** Normalize code-fence display labels before looking up a syntax grammar. */
export function normalizeMarkdownCodeLanguage(language: string): string {
  const normalized = language.trim().toLowerCase();
  return LANGUAGE_ALIASES.get(normalized) ?? normalized;
}
