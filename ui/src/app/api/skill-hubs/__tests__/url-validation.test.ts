/**
 * @jest-environment node
 *
 * Tests for URL hostname + include_paths validation in skill-hubs routes.
 * Verifies that hostname checks use exact match instead of substring match
 * to prevent SSRF / URL bypass attacks, that GitLab subgroup nesting is
 * preserved end-to-end (FR-022), and that `include_paths` is correctly
 * normalized + validated (FR-020).
 * assisted-by claude code claude-sonnet-4-6
 */

import {
  detectHubProviderFromUrl,
  normalizeHubLocation,
  validateIncludePaths,
  validateMaxTreePages,
} from "../_lib/normalize";
import { MAX_TREE_PAGES_HARD_LIMIT } from "@/lib/hub-crawl-constants";

describe("skill-hubs URL hostname validation", () => {

  it("normalizes a real github.com URL to owner/repo", () => {
    const result = normalizeHubLocation("https://github.com/owner/repo");
    expect(result).toBe("owner/repo");
  });

  it("normalizes a github subdomain URL", () => {
    const result = normalizeHubLocation("https://api.github.com/repos/owner/repo");
    expect(result).toBe("repos/owner");
  });

  it("does NOT normalize evil-github.com (substring attack)", () => {
    const raw = "https://evil-github.com/owner/repo";
    const result = normalizeHubLocation(raw);
    // Should not strip the hostname — remains as the raw input
    expect(result).toBe(raw);
  });

  it("does NOT normalize github.com.evil.com (suffix attack)", () => {
    const raw = "https://github.com.evil.com/owner/repo";
    const result = normalizeHubLocation(raw);
    expect(result).toBe(raw);
  });

  it("normalizes a real gitlab.com URL to owner/repo", () => {
    const result = normalizeHubLocation("https://gitlab.com/owner/repo", "gitlab");
    expect(result).toBe("owner/repo");
  });

  it("does NOT normalize evil-gitlab.com", () => {
    const raw = "https://evil-gitlab.com/owner/repo";
    const result = normalizeHubLocation(raw, "gitlab");
    expect(result).toBe(raw);
  });

  it("leaves plain owner/repo string unchanged", () => {
    const result = normalizeHubLocation("owner/repo");
    expect(result).toBe("owner/repo");
  });

  // FR-022 / SC-010: GitLab subgroup nesting must survive normalization.
  it("preserves every path segment for gitlab.com subgroup URLs", () => {
    const result = normalizeHubLocation(
      "https://gitlab.com/mycorp/devops/platform",
      "gitlab",
    );
    expect(result).toBe("mycorp/devops/platform");
  });

  it("preserves arbitrarily-deep GitLab subgroup nesting", () => {
    const result = normalizeHubLocation(
      "https://gitlab.com/group/subgroup/sub-subgroup/project",
      "gitlab",
    );
    expect(result).toBe("group/subgroup/sub-subgroup/project");
  });

  it("strips GitLab UI suffixes (e.g. /-/tree/main) while keeping subgroups", () => {
    const result = normalizeHubLocation(
      "https://gitlab.com/mycorp/devops/platform/-/tree/main",
      "gitlab",
    );
    expect(result).toBe("mycorp/devops/platform");
  });

  // Regression: a user pasted `https://gitlab.com/gitlab-org/ai/skills`
  // into the admin "Preview skills (crawl)" form and got
  // "GitLab API error: 404 Not Found" because the preview route did
  // not run `normalizeHubLocation` before calling `crawlGitLabRepo`,
  // so the full URL got `encodeURIComponent`'d into the GitLab API
  // project lookup. Pin the normalization here so the route can rely
  // on the canonical `gitlab-org/ai/skills` form regardless of how
  // the URL was typed.
  it("normalizes the gitlab-org/ai/skills repro URL to the canonical path", () => {
    const result = normalizeHubLocation(
      "https://gitlab.com/gitlab-org/ai/skills",
      "gitlab",
    );
    expect(result).toBe("gitlab-org/ai/skills");
  });

  it("normalizes a gitlab.com URL with a trailing slash", () => {
    const result = normalizeHubLocation(
      "https://gitlab.com/gitlab-org/ai/skills/",
      "gitlab",
    );
    expect(result).toBe("gitlab-org/ai/skills");
  });

  it("still flattens GitHub URLs to two segments (no subgroup support)", () => {
    const result = normalizeHubLocation(
      "https://github.com/owner/repo/tree/main",
      "github",
    );
    expect(result).toBe("owner/repo");
  });

  // -------------------------------------------------------------------------
  // .git suffix stripping — regression for the screenshot bug where
  // pasting a clone URL produced a confusing 404 because the literal
  // ".git" segment was URL-encoded into the API project path.
  // -------------------------------------------------------------------------

  it("strips a trailing .git from a GitLab clone URL (regression)", () => {
    // Exact bug report: kkantesaria/skills-marketplace.git on a
    // self-hosted GitLab.
    const previousApi = process.env.GITLAB_API_URL;
    process.env.GITLAB_API_URL = "https://cd.splunkdev.com/api/v4";
    try {
      expect(
        normalizeHubLocation(
          "https://cd.splunkdev.com/kkantesaria/skills-marketplace.git",
          "gitlab",
        ),
      ).toBe("kkantesaria/skills-marketplace");
    } finally {
      if (previousApi === undefined) delete process.env.GITLAB_API_URL;
      else process.env.GITLAB_API_URL = previousApi;
    }
  });

  it("strips a trailing .git from a gitlab.com clone URL with subgroups", () => {
    expect(
      normalizeHubLocation(
        "https://gitlab.com/group/subgroup/project.git",
        "gitlab",
      ),
    ).toBe("group/subgroup/project");
  });

  it("strips a trailing .git from a GitHub clone URL", () => {
    expect(
      normalizeHubLocation("https://github.com/owner/repo.git", "github"),
    ).toBe("owner/repo");
  });

  it("strips a trailing .git from a canonical-form (non-URL) input", () => {
    expect(
      normalizeHubLocation("kkantesaria/skills-marketplace.git", "gitlab"),
    ).toBe("kkantesaria/skills-marketplace");
    expect(normalizeHubLocation("owner/repo.git", "github")).toBe("owner/repo");
  });

  it("does NOT strip .git from intermediate path segments", () => {
    // A real-world group named ``some.git-stuff`` mid-path must survive.
    expect(
      normalizeHubLocation(
        "https://gitlab.com/some.git-stuff/project",
        "gitlab",
      ),
    ).toBe("some.git-stuff/project");
  });

  it("does NOT strip a bare '.git' segment (length-guard)", () => {
    // The bare ``.git`` segment would collapse to ``""`` if we
    // naively stripped — the length check guarantees we leave it
    // alone. The URL is otherwise normalized normally (path
    // preserved as-is for GitLab).
    expect(
      normalizeHubLocation("https://gitlab.com/owner/.git", "gitlab"),
    ).toBe("owner/.git");
  });
});

describe("skill-hubs include_paths validation (FR-020)", () => {
  it("returns undefined for absent input", () => {
    expect(validateIncludePaths(undefined)).toBeUndefined();
    expect(validateIncludePaths(null)).toBeUndefined();
  });

  it("returns undefined for an empty array (so existing docs are untouched)", () => {
    expect(validateIncludePaths([])).toBeUndefined();
  });

  it("appends a trailing slash to each entry", () => {
    expect(validateIncludePaths(["skills", "agents/ops/skills/"])).toEqual([
      "skills/",
      "agents/ops/skills/",
    ]);
  });

  it("trims whitespace and drops empties", () => {
    expect(validateIncludePaths(["  skills  ", "", "  ", "agents/"])).toEqual([
      "skills/",
      "agents/",
    ]);
  });

  it("dedupes preserving order", () => {
    expect(
      validateIncludePaths(["skills/", "skills", "agents/", "skills"]),
    ).toEqual(["skills/", "agents/"]);
  });

  it("rejects entries containing '..'", () => {
    expect(() => validateIncludePaths(["../escape"])).toThrow(/\.\./);
  });

  it("rejects entries with leading slash", () => {
    expect(() => validateIncludePaths(["/abs/path"])).toThrow(/must not start with "\/"/);
  });

  it("rejects entries with disallowed characters", () => {
    expect(() => validateIncludePaths(["skills with space/"])).toThrow(
      /disallowed characters/,
    );
    expect(() => validateIncludePaths(["weird*char/"])).toThrow(
      /disallowed characters/,
    );
  });

  it("caps at 20 entries", () => {
    const tooMany = Array.from({ length: 21 }, (_, i) => `dir${i}/`);
    expect(() => validateIncludePaths(tooMany)).toThrow(/maximum of 20/);
  });

  it("rejects non-array input", () => {
    expect(() => validateIncludePaths("skills/")).toThrow(/must be an array/);
  });

  it("rejects non-string entries", () => {
    expect(() => validateIncludePaths([42 as unknown as string])).toThrow(
      /entries must be strings/,
    );
  });

  it("accepts a typical 2-prefix configuration round-trip", () => {
    expect(
      validateIncludePaths(["skills/", "agents/observability/skills/"]),
    ).toEqual(["skills/", "agents/observability/skills/"]);
  });
});

describe("hub-crawl.ts GitHub URL normalization", () => {
  function normalizeCrawlLoc(rawLoc: string): string {
    let loc = rawLoc;
    try {
      const url = new URL(loc);
      if (url.hostname === "github.com" || url.hostname.endsWith(".github.com")) {
        loc = url.pathname.replace(/^\/+|\/+$/g, "");
      }
    } catch {
      // Not a URL — assume owner/repo
    }
    return loc;
  }

  it("strips github.com prefix from full URL", () => {
    expect(normalizeCrawlLoc("https://github.com/caipe-io/ai-platform-engineering")).toBe(
      "caipe-io/ai-platform-engineering"
    );
  });

  it("strips github subdomain prefix", () => {
    expect(normalizeCrawlLoc("https://raw.github.com/caipe-io/ai-platform-engineering")).toBe(
      "caipe-io/ai-platform-engineering"
    );
  });

  it("does NOT strip evil-github.com", () => {
    const raw = "https://evil-github.com/caipe-io/ai-platform-engineering";
    expect(normalizeCrawlLoc(raw)).toBe(raw);
  });

  it("does NOT strip github.com.attacker.com", () => {
    const raw = "https://github.com.attacker.com/caipe-io/ai-platform-engineering";
    expect(normalizeCrawlLoc(raw)).toBe(raw);
  });

  it("passes through plain owner/repo string", () => {
    expect(normalizeCrawlLoc("caipe-io/ai-platform-engineering")).toBe(
      "caipe-io/ai-platform-engineering"
    );
  });
});

// ---------------------------------------------------------------------------
// `detectHubProviderFromUrl` — provider classifier used by the admin form
// auto-switch and by the route handler backstop. The screenshot
// regression that motivated this helper: pasting
// `https://gitlab.com/gitlab-org/ai/skills` into the form while the
// GitHub source pill was selected silently produced a GitHub API call
// against `gitlab-org/ai`, which 404s. These tests pin the host
// allow-list rules — including the security property that we never
// substring-match `github` / `gitlab` inside arbitrary hostnames.
// ---------------------------------------------------------------------------

describe("detectHubProviderFromUrl", () => {
  it("classifies github.com URLs as github", () => {
    expect(detectHubProviderFromUrl("https://github.com/owner/repo")).toBe("github");
    expect(detectHubProviderFromUrl("http://github.com/owner/repo")).toBe("github");
    expect(detectHubProviderFromUrl("https://www.github.com/owner/repo")).toBe("github");
    expect(detectHubProviderFromUrl("https://api.github.com/repos/x")).toBe("github");
  });

  it("classifies gitlab.com URLs as gitlab", () => {
    expect(detectHubProviderFromUrl("https://gitlab.com/group/project")).toBe("gitlab");
    expect(detectHubProviderFromUrl("https://gitlab.com/group/sub/project")).toBe("gitlab");
  });

  it("classifies the screenshot URL as gitlab", () => {
    // Regression pin for the exact URL the admin pasted into the form
    // while GitHub was selected.
    expect(
      detectHubProviderFromUrl("https://gitlab.com/gitlab-org/ai/skills"),
    ).toBe("gitlab");
  });

  it("returns null for plain owner/repo (no URL)", () => {
    expect(detectHubProviderFromUrl("owner/repo")).toBeNull();
    expect(detectHubProviderFromUrl("group/sub/project")).toBeNull();
  });

  it("returns null for empty / whitespace input", () => {
    expect(detectHubProviderFromUrl("")).toBeNull();
    expect(detectHubProviderFromUrl("   ")).toBeNull();
  });

  it("rejects evil-github.com (substring attack)", () => {
    expect(detectHubProviderFromUrl("https://evil-github.com/owner/repo")).toBeNull();
  });

  it("rejects github.com.attacker.com (suffix attack)", () => {
    expect(
      detectHubProviderFromUrl("https://github.com.attacker.com/owner/repo"),
    ).toBeNull();
  });

  it("rejects evil-gitlab.com (substring attack)", () => {
    expect(detectHubProviderFromUrl("https://evil-gitlab.com/group/project")).toBeNull();
  });

  it("rejects non-http(s) schemes", () => {
    // Defense-in-depth: SSH-style URLs and file://, etc., never match.
    expect(detectHubProviderFromUrl("ssh://github.com/owner/repo")).toBeNull();
    expect(detectHubProviderFromUrl("file:///etc/passwd")).toBeNull();
  });

  it("returns null for unparseable input", () => {
    // URLs that look like URLs but URL constructor rejects.
    expect(detectHubProviderFromUrl("https://[not-a-valid-host")).toBeNull();
  });

  it("recognizes self-hosted GitLab via GITLAB_API_URL", () => {
    const prev = process.env.GITLAB_API_URL;
    try {
      process.env.GITLAB_API_URL = "https://gitlab.mycorp.com/api/v4";
      expect(
        detectHubProviderFromUrl("https://gitlab.mycorp.com/group/project"),
      ).toBe("gitlab");
      // Subdomains of the configured host also match.
      expect(
        detectHubProviderFromUrl("https://review.gitlab.mycorp.com/group/project"),
      ).toBe("gitlab");
    } finally {
      if (prev === undefined) delete process.env.GITLAB_API_URL;
      else process.env.GITLAB_API_URL = prev;
    }
  });
});

// ---------------------------------------------------------------------------
// `validateMaxTreePages` — accepts a positive integer (the per-hub
// override of the GitLab tree-page cap), `null` (caller-cleared), or
// undefined (absent). Anything else throws ApiError(400) so the route
// surfaces a clear toast instead of silently coercing.
// ---------------------------------------------------------------------------

describe("validateMaxTreePages", () => {
  it("returns undefined when the field is absent", () => {
    expect(validateMaxTreePages(undefined)).toBeUndefined();
  });

  it("returns null when the caller explicitly clears the override", () => {
    // PATCH route uses null to delete `max_tree_pages` from the doc so
    // the crawler reverts to the env-var default.
    expect(validateMaxTreePages(null)).toBeNull();
  });

  it("treats an empty string as 'no override' (returns undefined)", () => {
    expect(validateMaxTreePages("")).toBeUndefined();
    expect(validateMaxTreePages("   ")).toBeUndefined();
  });

  it("accepts a positive integer", () => {
    expect(validateMaxTreePages(50)).toBe(50);
    expect(validateMaxTreePages(1)).toBe(1);
    expect(validateMaxTreePages(MAX_TREE_PAGES_HARD_LIMIT)).toBe(MAX_TREE_PAGES_HARD_LIMIT);
  });

  it("accepts numeric strings (form input arrives as strings)", () => {
    expect(validateMaxTreePages("100")).toBe(100);
    expect(validateMaxTreePages("  42  ")).toBe(42);
  });

  it("floors fractional values (we want pages, not partial pages)", () => {
    expect(validateMaxTreePages(50.9)).toBe(50);
    expect(validateMaxTreePages("50.9")).toBe(50);
  });

  it("rejects zero, negatives, and non-finite numbers", () => {
    expect(() => validateMaxTreePages(0)).toThrow(/positive integer/);
    expect(() => validateMaxTreePages(-1)).toThrow(/positive integer/);
    expect(() => validateMaxTreePages(Infinity)).toThrow(/positive integer/);
    expect(() => validateMaxTreePages(NaN)).toThrow(/positive integer/);
  });

  it("rejects non-numeric strings and non-number/non-string types", () => {
    expect(() => validateMaxTreePages("not a number")).toThrow(/positive integer/);
    expect(() => validateMaxTreePages({})).toThrow(/positive integer/);
    expect(() => validateMaxTreePages([])).toThrow(/positive integer/);
    // Booleans coerce to NaN through Number() — we want them rejected
    // up front rather than accidentally interpreted as 0/1.
    expect(() => validateMaxTreePages(true)).toThrow(/positive integer/);
  });

  it("rejects values above the hard limit", () => {
    expect(() => validateMaxTreePages(MAX_TREE_PAGES_HARD_LIMIT + 1)).toThrow(
      new RegExp(`hard limit of ${MAX_TREE_PAGES_HARD_LIMIT}`),
    );
    expect(() => validateMaxTreePages("999999")).toThrow(/hard limit/);
  });
});
