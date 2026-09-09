import { redirect } from "next/navigation";

type LegacyEmbedPageProps = {
  params: Promise<{ appId: string; path?: string[] }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

/**
 * Preserve links created before hosted Agentic Apps moved to `/apps/<id>`.
 *
 * The canonical route owns authentication and app access checks. This route
 * only translates the legacy URL shape, so an old link cannot bypass those
 * controls.
 */
export default async function LegacyAgenticAppEmbedPage({
  params,
  searchParams,
}: LegacyEmbedPageProps): Promise<never> {
  const [{ appId, path = [] }, query] = await Promise.all([
    params,
    searchParams,
  ]);
  const targetPath = `/apps/${[appId, ...path]
    .map((segment) => encodeURIComponent(segment))
    .join("/")}`;
  const targetQuery = new URLSearchParams();

  for (const [key, value] of Object.entries(query)) {
    if (Array.isArray(value)) {
      value.forEach((item) => targetQuery.append(key, item));
    } else if (value !== undefined) {
      targetQuery.set(key, value);
    }
  }

  const queryString = targetQuery.toString();
  redirect(queryString ? `${targetPath}?${queryString}` : targetPath);
}
