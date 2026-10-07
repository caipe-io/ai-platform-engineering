import { redirect } from "next/navigation";

type LegacyEmbedPageProps = {
  params: Promise<{ appId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

/**
 * Preserve links created before hosted Agentic Apps moved to `/apps/<id>`.
 *
 * The canonical route owns authentication and app access checks. This route
 * only translates the legacy URL shape, so an old link cannot bypass the
 * normal AuthGuard or the runtime's authorization checks.
 */
export default async function LegacyAgenticAppEmbedPage({
  params,
  searchParams,
}: LegacyEmbedPageProps): Promise<never> {
  const [{ appId }, query] = await Promise.all([params, searchParams]);
  const target = new URL(`/apps/${encodeURIComponent(appId)}`, "http://caipe.local");

  for (const [key, value] of Object.entries(query)) {
    if (Array.isArray(value)) {
      value.forEach((item) => target.searchParams.append(key, item));
    } else if (value !== undefined) {
      target.searchParams.set(key, value);
    }
  }

  redirect(`${target.pathname}${target.search}`);
}
