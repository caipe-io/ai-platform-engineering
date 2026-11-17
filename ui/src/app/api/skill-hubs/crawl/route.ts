import { githubHubOptions } from "@/lib/github-hub-options";
import {
apiHostFromBaseUrl,
buildCrawlStreamResponse,
wantsNdjsonStream,
} from "@/app/api/skill-hubs/_lib/crawl-stream-response";
import {
detectHubProviderFromUrl,
normalizeHubLocation,
} from "@/app/api/skill-hubs/_lib/normalize";
import {
getAuthFromBearerOrSession,
requireRbacPermission,
validateCredentialsRef,
withErrorHandler,
} from "@/lib/api-middleware";
import { crawlGitHubRepo,crawlGitLabRepo } from "@/lib/hub-crawl";
import { NextRequest,NextResponse } from "next/server";

/**
 * POST /api/skill-hubs/crawl — preview SKILL.md paths for a repo (FR-017).
 *
 * Crawls GitHub and GitLab directly from the Next.js process via
 * `crawlGitHubRepo` / `crawlGitLabRepo`. The Python `skills_middleware`
 * intentionally does **not** reach out to GitHub/GitLab — its catalog
 * read path is Mongo-only (`hub_skills` collection populated by this
 * route's bulk siblings + the hub admin scans). Admin only.
 */
export const POST = withErrorHandler(async (request: NextRequest): Promise<NextResponse> => {
  const { session } = await getAuthFromBearerOrSession(request);
  await requireRbacPermission(session, "admin_ui", "admin");

    const body = await request.json();
    const { type, location } = body;
    const credentialsRef = validateCredentialsRef(body.credentials_ref);

    if (!type || !location || typeof location !== "string") {
      return NextResponse.json(
        { error: "bad_request", message: "Missing type or location." },
        { status: 400 },
      );
    }

    // Backstop guard: if the caller passes a URL whose host clearly
    // identifies a provider that disagrees with the declared `type`,
    // reject with an actionable error BEFORE we attempt a local crawl.
    // Catches the "GitHub selected + gitlab.com URL pasted" pitfall
    // where the GitHub URL parser would silently truncate the URL
    // path to its first two segments and fire a real GitHub API call
    // against a foreign group name (e.g.
    // `https://gitlab.com/gitlab-org/ai/skills` → owner=`gitlab-org`,
    // repo=`ai` → 404 from `api.github.com/repos/gitlab-org/ai/...`).
    // The form already auto-switches when the user pastes a URL, so
    // this is a defensive backstop for non-form callers (curl, tests,
    // future API consumers).
    const detected = detectHubProviderFromUrl(location);
    if (detected && detected !== type) {
      return NextResponse.json(
        {
          error: "type_location_mismatch",
          message:
            `The location URL is a ${detected === "github" ? "GitHub" : "GitLab"} URL ` +
            `but the request type is "${type}". Either change the source ` +
            `to ${detected === "github" ? "GitHub" : "GitLab"} or pass a ` +
            `${type === "github" ? "github.com" : "gitlab.com"} URL.`,
        },
        { status: 400 },
      );
    }

    // The preview button accepts whatever the admin types — typically a
    // full URL (`https://gitlab.com/group/sub/project`) rather than the
    // canonical `group/sub/project`. The shared `normalizeHubLocation`
    // collapses both to the form the crawlers expect: GitHub stays flat
    // (`owner/repo`); GitLab preserves subgroup nesting. Without this,
    // GitLab crawls hit `encodeURIComponent` against a full URL and
    // produce 404s from the GitLab API (the project lookup `/projects/
    // <id-or-encoded-path>` cannot resolve a URL-encoded URL).
    const maxPreview = 100;
    const normalizedLocation = normalizeHubLocation(
      location.trim(),
      type === "gitlab" ? "gitlab" : "github",
    );
    // Content negotiation: clients that opt in via
    // ``Accept: application/x-ndjson`` get the live streaming branch;
    // everything else (curl probes, tests, the existing
    // ``RepoImportPanel.tsx`` preview button) keeps getting the
    // original JSON shape. This is deliberately additive so the
    // legacy callsites don't have to change.
    const wantStream = wantsNdjsonStream(request);

    const githubOptions = type === "github" ? githubHubOptions(body) : {};
    try {
      if (type === "github") {
        const [owner, repo] = normalizedLocation.split("/").filter(Boolean);
        if (!owner || !repo) {
          return NextResponse.json(
            { error: "invalid_location", message: "Expected owner/repo." },
            { status: 400 },
          );
        }
        const token = (credentialsRef ? process.env[credentialsRef] : undefined)
          || process.env.GITHUB_TOKEN;

        if (wantStream) {
          // Stream branch: hand control to the shared helper, which
          // produces the started/...events.../done bookends and
          // serializes the events through the redaction pipeline.
          // Cast required because TypeScript can't unify Next's
          // NextResponse return type with the streaming Response;
          // ``Response`` is already what NextResponse extends.
          return buildCrawlStreamResponse({
            provider: "github",
            project: `${owner}/${repo}`,
            api_host: "api.github.com",
            run: async (emitter) => {
              const { skills: crawled, truncation } = await crawlGitHubRepo(
                owner,
                repo,
                token,
                undefined,
                emitter,
                githubOptions,
              );
              return { skills: crawled.length, truncation };
            },
          }) as unknown as NextResponse;
        }

        const { skills: crawled, truncation } = await crawlGitHubRepo(
          owner,
          repo,
          token,
          undefined,
          undefined,
          githubOptions,
        );
        const sliced = crawled.slice(0, maxPreview);
        return NextResponse.json({
          paths: sliced.map((s) => s.path),
          skills_preview: sliced.map((s) => ({
            path: s.path,
            name: s.name,
            description: s.description,
          })),
          truncation,
          error: null,
        });
      }

      if (type === "gitlab") {
        // Reject anything that still looks like a URL after normalization
        // (defensive: covers self-hosted hosts not in the GITLAB_API_URL
        // allow-list which `normalizeHubLocation` deliberately leaves
        // unchanged so we don't smuggle attacker-controlled hosts past
        // it). A URL here would silently produce 404s downstream.
        if (
          normalizedLocation.includes("://") ||
          !normalizedLocation.includes("/")
        ) {
          return NextResponse.json(
            {
              error: "invalid_location",
              message:
                "Expected a GitLab project path like 'group/project' or 'group/subgroup/project'. Self-hosted GitLab hosts must be configured via GITLAB_API_URL.",
            },
            { status: 400 },
          );
        }

        const token = (credentialsRef ? process.env[credentialsRef] : undefined)
          || process.env.GITLAB_TOKEN;

        // Preview honours an admin-supplied `max_tree_pages` if present
        // so the operator can verify the cap is high enough before
        // saving the hub.
        const previewMaxTreePages =
          typeof body.max_tree_pages === "number" &&
          Number.isFinite(body.max_tree_pages) &&
          body.max_tree_pages > 0
            ? Math.floor(body.max_tree_pages)
            : undefined;
        const baseUrl =
          process.env.GITLAB_API_URL || "https://gitlab.com/api/v4";

        if (wantStream) {
          return buildCrawlStreamResponse({
            provider: "gitlab",
            project: normalizedLocation,
            api_host: apiHostFromBaseUrl(baseUrl),
            run: async (emitter) => {
              const { skills: crawled, truncation } = await crawlGitLabRepo(
                normalizedLocation,
                token,
                undefined,
                previewMaxTreePages,
                emitter,
              );
              return { skills: crawled.length, truncation };
            },
            // Auto-introspect on auth failure -- this is the
            // mechanism that produces the precise "your token
            // has [read_repository] but needs read_api" hint,
            // closing the diagnostic loop the user spent real
            // time stuck inside.
            gitlabIntrospect: { baseUrl, token },
          }) as unknown as NextResponse;
        }

        const { skills: crawled, truncation } = await crawlGitLabRepo(
          normalizedLocation,
          token,
          undefined,
          previewMaxTreePages,
        );
        const sliced = crawled.slice(0, maxPreview);
        return NextResponse.json({
          paths: sliced.map((s) => s.path),
          skills_preview: sliced.map((s) => ({
            path: s.path,
            name: s.name,
            description: s.description,
          })),
          truncation,
          error: null,
        });
      }

      return NextResponse.json(
        { error: "unsupported_type", message: `Type not supported: ${type}` },
        { status: 400 },
      );
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return NextResponse.json(
        { paths: [], skills_preview: [], error: message },
        { status: 502 },
      );
    }
});
