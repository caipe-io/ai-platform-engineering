/**
 * Quick install modal tests for `TrySkillsGateway`.
 *
 * The component is large and integrates many flows; this file deliberately
 * scopes assertions to the *Quick install* dialog (Step 1 → "Quick install"
 * button) which was redesigned in commit 91f2ad68. The intent is regression
 * coverage for the things a future refactor is most likely to break:
 *
 *   1. Summary chips render with the live skill count + selected agent +
 *      install path (the "what is about to happen?" preview).
 *   2. The API-key gate renders amber when no key is present and exposes
 *      a Generate button that POSTs to `/api/catalog-api-keys`.
 *   3. After minting, the gate flips to green and shows a single-shot
 *      bootstrap command with the one-time-visibility warning.
 *   4. The bootstrap command writes `~/.config/caipe/config.json` and then
 *      runs the install one-liner without a second redundant terminal block.
 *   5. The footer action closes the dialog.
 *
 * We mock `fetch` per-URL so the component receives realistic shapes from
 * `/api/skills/live-skills`, `/api/skills`, `/api/catalog-api-keys`, etc.
 * `next/navigation` and `next/link` are stubbed because they are imported
 * transitively and would otherwise throw outside an `<App>` router.
 */

import React from "react";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// ----------------------------------------------------------------------------
// Mocks for Next.js + UI primitives that do not behave under jsdom.
// ----------------------------------------------------------------------------

jest.mock("next/link", () => {
  // Render a plain anchor so we can assert href and click without a router.
  const Link = ({
    children,
    href,
    ...rest
  }: {
    children: React.ReactNode;
    href: string;
  }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  );
  Link.displayName = "MockNextLink";
  return { __esModule: true, default: Link };
});

jest.mock("next/navigation", () => ({
  useRouter: () => ({
    push: jest.fn(),
    replace: jest.fn(),
    back: jest.fn(),
    refresh: jest.fn(),
  }),
  usePathname: () => "/skills/gateway",
  useSearchParams: () => new URLSearchParams(),
}));

// ----------------------------------------------------------------------------
// Per-URL fetch mock. Returns minimally-realistic payloads for every URL the
// component touches on mount + Quick install open. Anything unexpected logs
// the URL so test failures are easy to debug.
// ----------------------------------------------------------------------------

interface FetchEntry {
  ok: boolean;
  status?: number;
  body?: unknown;
}

function jsonResponse({ ok, status = 200, body = {} }: FetchEntry) {
  return Promise.resolve({
    ok,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response);
}

const LIVE_SKILLS_BODY = {
  agent: "claude",
  label: "Claude Code",
  template: "# Live-skills\nDo a thing.",
  install_path: "~/.claude/skills/caipe-skills/SKILL.md",
  install_paths: {
    user: [
      "~/.claude/skills/caipe-skills/SKILL.md",
      "~/.agents/skills/caipe-skills/SKILL.md",
    ],
    project: [
      "./.claude/skills/caipe-skills/SKILL.md",
      "./.agents/skills/caipe-skills/SKILL.md",
    ],
  },
  scope: "user",
  scope_requested: "user",
  scope_fallback: false,
  scopes_available: ["user", "project"],
  file_extension: "md",
  format: "markdown-frontmatter",
  is_fragment: false,
  launch_guide:
    "## Launch the skill\n\nRun `/caipe-skills` inside Claude Code.\n",
  agents: [
    {
      id: "claude",
      label: "Claude Code",
      ext: "md",
      format: "markdown-frontmatter",
      install_paths: {
        user: [
          "~/.claude/skills/caipe-skills/SKILL.md",
          "~/.agents/skills/caipe-skills/SKILL.md",
        ],
        project: [
          "./.claude/skills/caipe-skills/SKILL.md",
          "./.agents/skills/caipe-skills/SKILL.md",
        ],
      },
      scopes_available: ["user", "project"],
      is_fragment: false,
    },
    {
      id: "cursor",
      label: "Cursor",
      ext: "md",
      format: "markdown-plain",
      install_paths: {
        project: "./.cursor/commands/skills.md",
      },
      scopes_available: ["project"],
      is_fragment: false,
    },
  ],
  source: "chart-default",
};

const SKILLS_LIST_BODY = {
  skills: [
    {
      name: "github-create-pr",
      metadata: {
        tags: ["github", "pr"],
        hub_location: "example/repo",
        hub_type: "github",
      },
    },
    {
      name: "argocd-list-apps",
      metadata: { tags: ["argocd"], hub_location: "example/repo", hub_type: "github" },
    },
  ],
  meta: { total: 10 },
};

// Low-entropy, obviously-fake fixture. Avoids tripping gitleaks'
// generic-api-key rule (which fires on entropy >~3.5) while still
// being a plausible string for the assertions below.
const FAKE_MINT_KEY = "FAKE-TEST-KEY-DO-NOT-USE";
let mintedKeyValue = FAKE_MINT_KEY;
let mintCallCount = 0;
let gatewayFailure: "html" | "null" | "invalid" | null = null;
const mintPostMock = jest.fn();

beforeEach(() => {
  mintCallCount = 0;
  gatewayFailure = null;
  mintPostMock.mockReset();
  mintedKeyValue = FAKE_MINT_KEY;

  global.fetch = jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();

    // Catalog API keys: GET (list) + POST (mint).
    if (url.startsWith("/api/catalog-api-keys")) {
      if (init?.method === "POST") {
        mintCallCount += 1;
        mintPostMock(url, init);
        return jsonResponse({
          ok: true,
          body: { key: mintedKeyValue, key_id: "kid-1" },
        });
      }
      return jsonResponse({ ok: true, body: { keys: [] } });
    }

    // Skills list (used for autocomplete + preview).
    if (url.startsWith("/api/skills") && !url.includes('/live-skills')) {
      return jsonResponse({ ok: true, body: SKILLS_LIST_BODY });
    }

    // Live-skills (per-agent rendered template).
    if (url.startsWith("/api/skills/live-skills")) {
      if (gatewayFailure) {
        const failure = gatewayFailure;
        return Promise.resolve({
          ok: failure === "invalid", status: failure === "invalid" ? 200 : 502,
          json: async () => {
            if (failure === "html") throw new SyntaxError("Unexpected token <");
            return null;
          },
        } as Response);
      }
      return jsonResponse({ ok: true, body: LIVE_SKILLS_BODY });
    }

    // Anything else: log + return empty 200 so we don't crash.
     
    console.warn("[test] unmocked fetch:", url);
    return jsonResponse({ ok: true, body: {} });
  }) as unknown as typeof fetch;

  // Stub clipboard.writeText so we can assert what was copied. JSDOM
  // exposes `navigator.clipboard` as a getter-only property, so a plain
  // `Object.assign(navigator, ...)` throws. `defineProperty` with
  // `configurable: true` lets us replace it for the duration of the test.
  // Hold on to the mock instance so each test can assert against it
  // without round-tripping through `navigator.clipboard.writeText` (the
  // round-trip loses the jest.Mock typing under JSDOM's getter).
  clipboardWriteTextMock = jest.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: clipboardWriteTextMock },
  });
});

// Shared handle to the most recent clipboard mock so individual tests can
// `mockClear` / inspect calls without re-resolving the property.
let clipboardWriteTextMock: jest.Mock;

afterEach(() => {
  jest.restoreAllMocks();
});

it.each(["html", "null", "invalid"] as const)("shows a useful gateway error for %s responses", async (failure) => {
  gatewayFailure = failure;
  const { TrySkillsGateway } = await import("../TrySkillsGateway");
  render(<TrySkillsGateway />);
  expect(await screen.findByRole("alert")).toHaveTextContent(
    failure === "invalid" ? "Unable to load the gateway skill: invalid response" : "Unable to load the gateway skill (502)",
  );
});

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

async function renderAndOpenModal({
  pickScope = true,
}: { pickScope?: boolean } = {}) {
  // Lazy-import so module-level mocks above are applied first.
  const { TrySkillsGateway } = await import("../TrySkillsGateway");
  const user = userEvent.setup();
  render(<TrySkillsGateway />);

  // Wait for the live-skills fetch to resolve so the modal has agents +
  // install_paths populated. Without this the dialog opens with
  // "Pick an install scope" because `liveSkills` is still null.
  await waitFor(() =>
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/skills/live-skills"),
      expect.anything(),
    ),
  );
  // The gateway page is quick-install first: a single primary CTA opens
  // the dialog, while catalog filtering and manual install details live
  // behind Advanced disclosures.
  await waitFor(() => {
    const buttons = screen.getAllByRole("button", {
      name: /^quick install skills$/i,
    });
    expect(buttons).toHaveLength(1);
    expect(buttons[0]).toBeEnabled();
  });

  await user.click(
    screen.getByRole("button", { name: /^quick install skills$/i }),
  );
  await screen.findByRole("heading", { name: /quick install/i });

  // The component starts with `selectedScope = null`, so the snippet area
  // shows "Pick an install scope above..." until the user clicks one of
  // the radio buttons inside the dialog. Most of our assertions need the
  // populated state, so default to picking project-local.
  if (pickScope) {
    const dialog = screen.getByRole("dialog");
    const projectRadio = within(dialog).getByRole("radio", {
      name: /project-local/i,
    });
    await user.click(projectRadio);
    // Wait for the chip row to render (proxy for "selectedScope is set").
    await waitFor(() =>
      expect(
        within(dialog).queryByText(
          /pick an install scope above to generate/i,
        ),
      ).toBeNull(),
    );
  }
  return user;
}

async function openModalAdvancedOptions(user: ReturnType<typeof userEvent.setup>) {
  // assisted-by Codex Codex-sonnet-4-6
  const dialog = getDialog();
  await user.click(within(dialog).getByText(/^Advanced install options$/i));
}

async function mintQuickInstallKey(user: ReturnType<typeof userEvent.setup>) {
  const dialog = getDialog();
  await user.click(
    within(dialog).getByRole("button", {
      name: /generate install command with api key/i,
    }),
  );
  await within(dialog).findByText(/API key minted/i);
}

function getDialog() {
  // shadcn/ui Dialog renders with role="dialog".
  return screen.getByRole("dialog");
}

function getBootstrapSnippetText(dialog = getDialog()) {
  const panel = within(dialog).getByTestId("quick-install-bootstrap-snippet");
  const pre = panel.querySelector("pre");
  expect(pre).not.toBeNull();
  return pre!.textContent || "";
}

// ----------------------------------------------------------------------------
// Tests
// ----------------------------------------------------------------------------

describe("TrySkillsGateway → Quick install modal", () => {
  it("centers the gateway content and uses a wider desktop layout", async () => {
    const { TrySkillsGateway } = await import("../TrySkillsGateway");
    const { container } = render(<TrySkillsGateway />);

    const root = container.firstElementChild;
    expect(root).toHaveClass("mx-auto");
    expect(root).toHaveClass("w-full");
    expect(root).toHaveClass("max-w-[1600px]");
  });

  it("renders a quick-install-first page with advanced details collapsed", async () => {
    const { TrySkillsGateway } = await import("../TrySkillsGateway");
    render(<TrySkillsGateway />);

    await waitFor(() =>
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining("/api/skills/live-skills"),
        expect.anything(),
      ),
    );

    expect(screen.getAllByText("Quick install skills").length).toBeGreaterThan(0);
    expect(
      screen.getByRole("button", { name: /^quick install skills$/i }),
    ).toBeEnabled();
    expect(
      screen.getByText(
        /Install skills into your local coding agent\. Claude gets its native ~\/\.claude\/skills copy/i,
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/One guided flow generates/i)).toBeNull();
    expect(screen.queryByText(/Choose the default user-wide install/i)).toBeNull();

    expect(screen.queryByText(/Step 2: Generate API Key/i)).toBeNull();
    expect(screen.queryByText(/Step 3: Install skills/i)).toBeNull();
    expect(screen.getByText(/Advanced install options/i)).toBeVisible();
    expect(screen.getByText(/Choose specific skills or bulk install/i)).not.toBeVisible();
    expect(screen.getByText(/Manual and custom install options/i)).not.toBeVisible();
    expect(screen.queryByText(/Advanced:/i)).toBeNull();
    expect(screen.queryByText(/^Advanced filters$/i)).toBeNull();
    expect(
      screen.queryByText(/Advanced — customize the skill/i),
    ).toBeNull();
  });

  it("opens manual options inside the collapsed advanced install section", async () => {
    const { TrySkillsGateway } = await import("../TrySkillsGateway");
    const user = userEvent.setup();
    render(<TrySkillsGateway />);

    expect(
      screen.queryByText(/Advanced: manual and custom install options/i),
    ).toBeNull();
    expect(
      screen.queryByText(/Advanced — customize the skill/i),
    ).toBeNull();
    await user.click(screen.getByText(/Advanced install options/i));
    expect(screen.getByText(/Customize or install manually/i)).toBeInTheDocument();
    expect(screen.getByText(/Skill name/i)).toBeInTheDocument();
    expect(screen.getByText(/Launch your coding agent and use it/i)).toBeInTheDocument();
  });

  it("renders launch instructions as a standalone visible section", async () => {
    const { TrySkillsGateway } = await import("../TrySkillsGateway");
    render(<TrySkillsGateway />);

    expect(screen.getByText(/Launch your coding agent and use it/i)).toBeInTheDocument();
    expect(screen.getByText(/Installed Claude-native skills/i)).toBeInTheDocument();
    expect(screen.getByText(/Restart or reopen your coding agent/i)).toBeInTheDocument();
    expect(
      screen.getByText(/Open your coding agent \(Claude, Cursor, Codex, Gemini, Opencode\)/i),
    ).toBeInTheDocument();
    expect(
      screen.getAllByText((_, node) =>
        Boolean(
          node?.textContent?.includes(
            "/caipe-skills to browse/search or run an installed skill directly",
          ),
        ),
      ).length,
    ).toBeGreaterThan(0);
    expect(
      screen.getAllByText((_, node) =>
        Boolean(node?.textContent?.includes("/update-caipe-skills")),
      ).length,
    ).toBeGreaterThan(0);
    expect(
      screen.getAllByText((_, node) =>
        Boolean(node?.textContent?.includes("/create-ci-pipeline")),
      ).length,
    ).toBeGreaterThan(0);
    expect(screen.queryByText(/For Cursor, Codex CLI, Gemini CLI, and opencode/i)).toBeNull();
    expect(screen.queryByText(/Claude Code: use/i)).toBeNull();
    expect(screen.queryByText(/immediately discoverable/i)).toBeNull();
    expect(screen.queryByText(/\$skill-name/i)).toBeNull();
    expect(screen.queryByText(/\/skills list/i)).toBeNull();
    expect(screen.queryByText(/Detailed launch guide/i)).toBeNull();
    expect(screen.queryByText(/Install Claude Code/i)).toBeNull();
    expect(screen.queryByText(/npm install -g @anthropic-ai\/claude-code/i)).toBeNull();
    expect(screen.queryByText(/^2$/)).toBeNull();
  });

  it("opens catalog filters inside the collapsed advanced install section", async () => {
    const { TrySkillsGateway } = await import("../TrySkillsGateway");
    const user = userEvent.setup();
    render(<TrySkillsGateway />);

    expect(
      screen.queryByText(/Advanced: choose specific skills or bulk install/i),
    );
    await user.click(screen.getByText(/Advanced install options/i));
    expect(screen.getByText(/Choose specific skills or bulk install/i)).toBeInTheDocument();
    expect(screen.queryByText(/^Advanced filters$/i)).toBeNull();
    expect(screen.getByText(/Tags \(comma-separated\)/i)).toBeInTheDocument();
    expect(screen.getByText(/Visibility/i)).toBeInTheDocument();
    expect(screen.getByText(/include_content/i)).toBeInTheDocument();
  });

  it("does not request or render page_size from the gateway flow", async () => {
    const { TrySkillsGateway } = await import("../TrySkillsGateway");
    render(<TrySkillsGateway />);

    await waitFor(() =>
      expect(global.fetch).toHaveBeenCalledWith(
        "/api/skills",
        expect.anything(),
      ),
    );

    const fetchedUrls = (global.fetch as jest.Mock).mock.calls
      .map(([input]) => (typeof input === "string" ? input : input.toString()))
      .filter((url: string) => url.includes("/api/skills"));
    expect(fetchedUrls.some((url: string) => url.includes("page_size"))).toBe(false);
    expect(screen.queryByText(/page_size/i)).toBeNull();
  });

  it("renders the default live URL without a trailing question mark", async () => {
    const { TrySkillsGateway } = await import("../TrySkillsGateway");
    render(<TrySkillsGateway />);

    expect(
      await screen.findByText("http://localhost/api/skills"),
    ).toBeInTheDocument();
    expect(screen.queryByText("http://localhost/api/skills?")).toBeNull();
  });

  it("does not render the redundant catalog, agent, and path summary row", async () => {
    await renderAndOpenModal();
    const dialog = getDialog();

    expect(within(dialog).queryByText(/skills from catalog/i)).toBeNull();
    expect(within(dialog).queryByText(/^10 skills$/i)).toBeNull();
    expect(
      within(dialog).queryByText((_, node) =>
        Boolean(
          node?.textContent?.includes(
            "paths ./.agents/skills/caipe-skills/SKILL.md",
          ),
        ),
      ),
    ).toBeNull();
    expect(
      within(dialog).queryByText(
        "./.agents/skills/caipe-skills/SKILL.md./.agents/skills/caipe-skills/SKILL.md",
      ),
    ).toBeNull();
  });

  it("shows the API-key gate with the Generate button first when no key is present", async () => {
    await renderAndOpenModal();
    const dialog = getDialog();

    expect(within(dialog).queryByText(/No API key/i)).toBeNull();
    expect(within(dialog).queryByText(/Generate one in Step 1 first/i)).toBeNull();

    const apiKeyGate = within(dialog).getByTestId("quick-install-api-key-gate");
    const generateButton = within(apiKeyGate).getByRole("button", {
      name: /generate install command with api key/i,
    });
    expect(generateButton).toBeEnabled();
    expect(
      within(apiKeyGate).getByText(/Generate an API key first to install skills/i),
    ).toBeInTheDocument();
    expect(
      apiKeyGate.textContent?.indexOf("Generate Install Command with API Key"),
    ).toBeLessThan(
      apiKeyGate.textContent?.indexOf("Generate an API key first") ?? 0,
    );

    // Per PR #1268 review feedback (Jeff Napper #6): the snippet no longer
    // embeds the API key in any state — it's always a clean
    // `curl … | bash`, and install.sh reads the key from
    // ~/.config/caipe/config.json (Step 1). So we should NOT see the
    // `<your-catalog-api-key>` placeholder leak into the modal snippet
    // either.
    expect(
      within(dialog).queryByText(/<your-catalog-api-key>/),
    ).toBeNull();
    expect(within(dialog).queryByText(/Run this in your terminal/i)).toBeNull();
    expect(
      within(dialog).queryByTestId("quick-install-copy-bare-curl"),
    ).toBeNull();
  });

  it("keeps install options and overwrite policy collapsed by default", async () => {
    const user = await renderAndOpenModal();
    const dialog = getDialog();

    expect(
      within(dialog).getByText(/^Advanced install options$/i),
    ).toBeVisible();
    expect(within(dialog).getByText(/^Install options$/i)).not.toBeVisible();
    expect(within(dialog).getByText(/^Overwrite policy$/i)).not.toBeVisible();

    await openModalAdvancedOptions(user);

    expect(within(dialog).getByText(/^Install options$/i)).toBeVisible();
    expect(within(dialog).getByText(/^Overwrite policy$/i)).toBeVisible();
  });

  it("POSTs to /api/catalog-api-keys and flips the gate green after Generate", async () => {
    const user = await renderAndOpenModal();
    const dialog = getDialog();

    await user.click(
      within(dialog).getByRole("button", {
        name: /generate install command with api key/i,
      }),
    );

    await waitFor(() => expect(mintCallCount).toBeGreaterThanOrEqual(1));
    expect(mintPostMock).toHaveBeenCalledWith(
      "/api/catalog-api-keys",
      expect.objectContaining({ method: "POST", credentials: "include" }),
    );

    // Green "API key minted" row appears, amber row disappears.
    await within(dialog).findByText(/API key minted/i);
    expect(within(dialog).queryByText(/API key required/i)).toBeNull();

    // The full key should not be visible by default after mint. The
    // recommended bootstrap command carries it in masked form unless the
    // user explicitly reveals it.
    expect(within(dialog).queryByText(mintedKeyValue)).toBeNull();
    expect(dialog).toHaveTextContent(/cannot show this key\s+again/i);
    expect(within(dialog).queryByText(/Option A/i)).toBeNull();
    expect(within(dialog).queryByText(/Two options/i)).toBeNull();
    expect(
      within(dialog).getByTestId("quick-install-bootstrap-snippet"),
    ).toHaveTextContent("FAKE-T**************-USE");

    await user.click(
      within(dialog).getByRole("button", { name: /show api key/i }),
    );
    expect(
      within(dialog).getByTestId("quick-install-bootstrap-snippet"),
    ).toHaveTextContent(mintedKeyValue);
    expect(
      within(dialog).queryByText(/Run this in your terminal/i),
    ).toBeNull();
    expect(
      within(dialog).queryByTestId("quick-install-copy-bare-curl"),
    ).toBeNull();
    expect(
      within(dialog).queryByTestId("quick-install-bare-curl-snippet"),
    ).toBeNull();
    // But never as `export CAIPE_CATALOG_KEY=…` — install.sh reads the
    // key from ~/.config/caipe/config.json, not the env.
    expect(within(dialog).queryByText(/export CAIPE_CATALOG_KEY/)).toBeNull();
  });

  it("does not render a second terminal-only curl snippet after minting", async () => {
    const user = await renderAndOpenModal();
    const dialog = getDialog();

    await user.click(
      within(dialog).getByRole("button", {
        name: /generate install command with api key/i,
      }),
    );
    await within(dialog).findByText(/API key minted/i);

    expect(within(dialog).queryByText(/Run this in your terminal/i)).toBeNull();
    expect(
      within(dialog).queryByTestId("quick-install-copy-bare-curl"),
    ).toBeNull();
    expect(
      within(dialog).queryByTestId("quick-install-bare-curl-snippet"),
    ).toBeNull();
  });

  it("snippet is a clean curl one-liner regardless of mint state", async () => {
    // Per PR #1268 review feedback (Jeff Napper #6): the snippet must NEVER
    // embed the API key — not as `<your-catalog-api-key>`, not as the
    // freshly minted value. install.sh resolves the key from
    // ~/.config/caipe/config.json (Step 1).
    const user = await renderAndOpenModal();
    const dialog = getDialog();

    expect(
      within(dialog).queryByText(/<your-catalog-api-key>/),
    ).toBeNull();
    expect(within(dialog).queryByText(/export CAIPE_CATALOG_KEY/)).toBeNull();
    await openModalAdvancedOptions(user);
    // The `--upgrade` hint (idempotency advice) still belongs in the
    // modal, but now lives in the advanced install options.
    expect(within(dialog).getAllByText(/--upgrade/).length).toBeGreaterThan(0);
  });

  it("does not show a manual-options footer in the dialog", async () => {
    await renderAndOpenModal();
    const dialog = getDialog();

    expect(
      within(dialog).queryByText(/Want the manual heredoc/i),
    ).toBeNull();
    expect(
      within(dialog).queryByRole("button", {
        name: /close and view manual options/i,
      }),
    ).toBeNull();
  });

  it("keeps the quick install dialog free of preview-count summary chips", async () => {
    const user = await renderAndOpenModal();

    // Close the modal so we can hit the Preview button in the underlying
    // page (the modal sits above it and the Preview lives in Step 1).
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    // Trigger Preview: this hits /api/skills which is mocked above to
    // return meta.total = 10. Quick install should still avoid the
    // redundant summary chip row.
    await user.click(screen.getByText(/Advanced install options/i));
    await user.click(screen.getByRole("button", { name: /^preview$/i }));
    await waitFor(() =>
      expect(screen.getByText(/10 skill(s)? found/i)).toBeInTheDocument(),
    );

    await user.click(
      screen.getByRole("button", { name: /^quick install skills$/i }),
    );
    const dialog = await screen.findByRole("dialog");

    expect(within(dialog).queryByText(/^10 skills$/i)).toBeNull();
    expect(within(dialog).queryByText(/skills from catalog/i)).toBeNull();
  });

  // ---------------------------------------------------------------------
  // Overwrite-policy checkboxes (--upgrade / --force).
  //
  // The modal exposes two checkboxes that flip the rendered one-liner
  // between three modes:
  //
  //   * neither        → `curl … | bash`              (safe default)
  //   * --upgrade only → `curl … | bash -s -- --upgrade`
  //   * --force only   → `curl … | bash -s -- --force`
  //
  // The two checkboxes are mutually exclusive (install.sh treats
  // upgrade+force as force-wins, and exposing both as independent
  // toggles would let the UI ask for an illegal combination). These
  // tests pin (a) the default state, (b) each mode's effect on the
  // snippet, and (c) the mutual-exclusion rule.
  // ---------------------------------------------------------------------

  it("overwrite-policy: defaults to no flag and renders a clean curl | bash", async () => {
    const user = await renderAndOpenModal();
    const dialog = getDialog();
    await openModalAdvancedOptions(user);

    const upgrade = within(dialog).getByTestId(
      "quick-install-upgrade",
    ) as HTMLInputElement;
    const force = within(dialog).getByTestId(
      "quick-install-force",
    ) as HTMLInputElement;
    expect(upgrade.checked).toBe(false);
    expect(force.checked).toBe(false);

    await mintQuickInstallKey(user);

    const snippet = getBootstrapSnippetText(dialog);
    expect(snippet).toMatch(/\| bash$/);
    expect(snippet).not.toContain("bash -s --");
  });

  it("overwrite-policy: ticking --upgrade rewrites snippet to use bash -s -- --upgrade", async () => {
    const user = await renderAndOpenModal();
    const dialog = getDialog();
    await openModalAdvancedOptions(user);

    await user.click(within(dialog).getByTestId("quick-install-upgrade"));
    await mintQuickInstallKey(user);

    const snippet = getBootstrapSnippetText(dialog);
    expect(snippet).toMatch(/\| bash -s -- --upgrade$/);
  });

  it("overwrite-policy: ticking --force rewrites snippet to use bash -s -- --force", async () => {
    const user = await renderAndOpenModal();
    const dialog = getDialog();
    await openModalAdvancedOptions(user);

    await user.click(within(dialog).getByTestId("quick-install-force"));
    await mintQuickInstallKey(user);

    const snippet = getBootstrapSnippetText(dialog);
    expect(snippet).toMatch(/\| bash -s -- --force$/);
  });

  // ---------------------------------------------------------------------
  // Helpers checkbox (default ON).
  //
  // The Quick Install URL must include &mode=bulk-with-helpers when the
  // checkbox is on so the server installs /caipe-skills + /update-caipe-skills
  // helper SKILL.md files. Without this the route silently downgrades
  // to catalog-query mode (DO_HELPERS=0) because ?catalog_url= takes
  // precedence over a missing mode.
  // ---------------------------------------------------------------------

  it("helpers checkbox: defaults to ON and snippet contains &mode=bulk-with-helpers", async () => {
    const user = await renderAndOpenModal();
    const dialog = getDialog();
    await openModalAdvancedOptions(user);

    const helpers = within(dialog).getByTestId(
      "quick-install-helpers",
    ) as HTMLInputElement;
    expect(helpers.checked).toBe(true);

    await mintQuickInstallKey(user);

    const snippet = getBootstrapSnippetText(dialog);
    expect(snippet).toContain("mode=bulk-with-helpers");
  });

  it("helpers checkbox: unticking removes &mode=bulk-with-helpers from the snippet", async () => {
    const user = await renderAndOpenModal();
    const dialog = getDialog();
    await openModalAdvancedOptions(user);

    await user.click(within(dialog).getByTestId("quick-install-helpers"));
    await mintQuickInstallKey(user);

    const snippet = getBootstrapSnippetText(dialog);
    expect(snippet).not.toContain("mode=bulk-with-helpers");
    // The rest of the URL (scope, catalog_url) must still be there —
    // we're only stripping the mode override, not breaking the URL.
    expect(snippet).toMatch(/scope=(user|project)/);
    expect(snippet).toContain("catalog_url=");
  });

  it("helpers checkbox: stacks with --force (both flags coexist on the same one-liner)", async () => {
    const user = await renderAndOpenModal();
    const dialog = getDialog();
    await openModalAdvancedOptions(user);

    // Default state already has helpers=on; layer --force on top.
    await user.click(within(dialog).getByTestId("quick-install-force"));
    await mintQuickInstallKey(user);

    const text = getBootstrapSnippetText(dialog);
    expect(text).toContain("mode=bulk-with-helpers");
    expect(text).toMatch(/\| bash -s -- --force$/);
  });

  // ---------------------------------------------------------------------
  // Option-4 bootstrap snippet (writes ~/.config/caipe/config.json with
  // the minted key, then runs the install one-liner).
  //
  // Background: install.sh resolves the catalog API key from
  // ~/.config/caipe/config.json on disk (Step 1 of the gateway flow).
  // After a `--purge` uninstall the file is removed; on re-install the
  // user has to recreate it before the curl works. Asking them to do
  // that by hand is the most common stumble in the install flow, so
  // when a key is freshly minted in this session the modal also shows
  // a single-shot bootstrap that:
  //   1) `mkdir -p ~/.config/caipe` so the dir exists.
  //   2) `cat > ~/.config/caipe/config.json <<'CAIPE_BOOTSTRAP_EOF'`
  //      using a *single-quoted* heredoc delimiter so bash doesn't try
  //      to expand $-sequences or backticks inside the embedded key.
  //   3) `chmod 600` the file (owner-readable only — the key is a
  //      bearer credential).
  //   4) Pipes into the same `curl … | bash` the bare snippet shows.
  //
  // These tests pin the *shape* of that snippet so a future refactor
  // can't silently regress security (chmod 600), correctness (quoted
  // heredoc), or completeness (must end with the install one-liner).
  // ---------------------------------------------------------------------

  it("bootstrap snippet: does NOT render until a key is minted", async () => {
    await renderAndOpenModal();
    const dialog = getDialog();

    expect(
      within(dialog).queryByTestId("quick-install-bootstrap-snippet"),
    ).toBeNull();
  });

  it("bootstrap snippet: renders with quoted heredoc, chmod 600, and the embedded key after mint", async () => {
    const user = await renderAndOpenModal();
    const dialog = getDialog();

    await user.click(
      within(dialog).getByRole("button", {
        name: /generate install command with api key/i,
      }),
    );
    await within(dialog).findByText(/API key minted/i);

    const panel = within(dialog).getByTestId(
      "quick-install-bootstrap-snippet",
    );
    const pre = panel.querySelector("pre");
    expect(pre).not.toBeNull();
    const text = pre!.textContent || "";

    // Step 1 — the dir is created before we try to `cat >` into it.
    // First-time installers don't have ~/.config/caipe yet.
    expect(text).toMatch(/^mkdir -p ~\/\.config\/caipe && \\$/m);

    // Step 2 — quoted heredoc delimiter. This is the load-bearing
    // bit: a bare `<<EOF` (or `<<"EOF"`) would let bash expand
    // `$(...)`, `` `...` ``, and `${...}` inside the embedded key,
    // which can corrupt the key or, worse, execute attacker-chosen
    // code if a future key format ever contains `$(...)`. We
    // single-quote the delimiter to disable all expansion.
    expect(text).toContain("<<'CAIPE_BOOTSTRAP_EOF'");
    // And the closing delimiter must match (no quotes on the closing
    // line, per heredoc syntax).
    expect(text).toMatch(/^CAIPE_BOOTSTRAP_EOF$/m);
    expect(text).not.toContain("<<EOF");
    expect(text).not.toContain('<<"CAIPE_BOOTSTRAP_EOF"');

    // The minted key is embedded in the copied payload, but the visible
    // snippet masks it by default to avoid shoulder-surfing/leaking it in
    // screenshots.
    expect(text).not.toContain(`"api_key": "${FAKE_MINT_KEY}"`);
    expect(text).toContain('"api_key": "FAKE-T**************-USE"');
    expect(text).toMatch(/"base_url":\s*"[^"]+"/);

    await user.click(
      within(dialog).getByRole("button", { name: /show api key/i }),
    );
    const revealedText = pre!.textContent || "";
    expect(revealedText).toContain(`"api_key": "${FAKE_MINT_KEY}"`);

    // Step 3 — chmod 600 must come immediately after the heredoc and
    // *before* the install runs. The `&& \` chain means a failed
    // chmod aborts the install.
    expect(text).toContain("chmod 600 ~/.config/caipe/config.json && \\");

    // Step 4 — the snippet ends with the install one-liner.
    expect(text).toMatch(/\ncurl -fsSL '[^']+' \| bash$/);
    expect(text).toContain("/api/skills/install.sh?");
  });

  it("bootstrap snippet: install one-liner inside it tracks the --force toggle", async () => {
    const user = await renderAndOpenModal();
    const dialog = getDialog();

    await user.click(
      within(dialog).getByRole("button", {
        name: /generate install command with api key/i,
      }),
    );
    await within(dialog).findByText(/API key minted/i);

    // Tick --force in the overwrite-policy panel — the bootstrap
    // snippet's install line must pick up the same flag, otherwise
    // the two snippets would silently diverge on overwrite policy.
    await openModalAdvancedOptions(user);
    await user.click(within(dialog).getByTestId("quick-install-force"));

    const panel = within(dialog).getByTestId(
      "quick-install-bootstrap-snippet",
    );
    const text = panel.querySelector("pre")!.textContent || "";
    expect(text).toMatch(/\| bash -s -- --force$/);
  });

  it("overwrite-policy: --upgrade and --force are mutually exclusive", async () => {
    const user = await renderAndOpenModal();
    const dialog = getDialog();
    await openModalAdvancedOptions(user);

    const upgrade = within(dialog).getByTestId(
      "quick-install-upgrade",
    ) as HTMLInputElement;
    const force = within(dialog).getByTestId(
      "quick-install-force",
    ) as HTMLInputElement;

    await user.click(upgrade);
    expect(upgrade.checked).toBe(true);
    expect(force.checked).toBe(false);

    // Picking force flips upgrade off — install.sh treats them as
    // a precedence chain, so two independent toggles would let the
    // UI claim a state the script silently ignores.
    await user.click(force);
    expect(force.checked).toBe(true);
    expect(upgrade.checked).toBe(false);

    // Unticking the active one returns to the safe default (clean
    // `| bash` with no flag).
    await user.click(force);
    expect(upgrade.checked).toBe(false);
    expect(force.checked).toBe(false);
    await mintQuickInstallKey(user);
    const snippet = getBootstrapSnippetText(dialog);
    expect(snippet).not.toContain("bash -s --");
  });
});
