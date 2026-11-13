/**
 * Unit + regression tests for #3086: a deleted skill must not reappear in the
 * SkillsGallery after (1) an out-of-order catalog response or (2) a failed
 * post-delete catalog refresh.
 *
 * Unit tests: request-ordering guard in `reloadCatalog` and the local catalog
 * prune in `confirmDelete`, each in isolation.
 * Regression tests: the two scenarios reported in the issue, end to end.
 */

import React from "react";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { SkillsGallery } from "../SkillsGallery";
import type { AgentSkill } from "@/types/agent-skill";

jest.mock("@/lib/config", () => ({
  getConfig: jest.fn(() => false),
  config: {},
}));

const mockLoadSkills = jest.fn();
const mockDeleteSkill = jest.fn();
const mockToast = jest.fn();
let _configs: AgentSkill[] = [];

jest.mock("@/store/agent-skills-store", () => ({
  useAgentSkillsStore: () => ({
    configs: _configs,
    isLoading: false,
    error: null,
    loadSkills: mockLoadSkills,
    deleteSkill: mockDeleteSkill,
    toggleFavorite: jest.fn(),
    isFavorite: jest.fn().mockReturnValue(false),
    getFavoriteSkills: jest.fn().mockReturnValue([]),
  }),
}));

jest.mock("@/store/chat-store", () => ({
  useChatStore: () => ({
    createConversation: jest.fn(),
    setPendingMessage: jest.fn(),
  }),
}));

jest.mock("@/hooks/use-admin-role", () => ({
  useAdminRole: () => ({ isAdmin: false }),
}));

jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn() }),
}));

jest.mock("next-auth/react", () => ({
  useSession: () => ({ data: { user: { email: "test@example.com" } }, status: "authenticated" }),
}));

jest.mock("framer-motion", () => ({
  motion: {
    // eslint-disable-next-line react/display-name
    div: React.forwardRef(({ children, ...rest }: unknown, ref: unknown) => (
      <div ref={ref} {...rest}>{children}</div>
    )),
  },
  AnimatePresence: ({ children }: unknown) => <>{children}</>,
}));

jest.mock("react-markdown", () => ({
  __esModule: true,
  default: ({ children }: unknown) => <div>{children}</div>,
}));

jest.mock("remark-gfm", () => ({
  __esModule: true,
  default: () => {},
}));

jest.mock("@/components/ui/caipe-spinner", () => ({
  CAIPESpinner: ({ message }: unknown) => <div data-testid="spinner">{message}</div>,
}));

jest.mock("@/components/ui/toast", () => ({
  useToast: () => ({ toast: mockToast }),
}));

// The indicator doubles as a trigger for the gallery's `refreshAll`
// (`onScanComplete`), which lets tests start an extra catalog request.
jest.mock("../SkillScanStatusIndicator", () => ({
  __esModule: true,
  SkillScanStatusIndicator: ({
    config,
    onScanComplete,
  }: {
    config: { id: string };
    onScanComplete?: () => void;
  }) => (
    <button
      type="button"
      data-testid={`scan-complete-${config.id}`}
      onClick={() => onScanComplete?.()}
    >
      mock-scan-indicator
    </button>
  ),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MONGO_ID = "skill-delete-3086";
const SKILL_NAME = "to-delete-3086";

function catalogRow(id = MONGO_ID, name = SKILL_NAME) {
  return {
    id,
    name,
    description: name,
    source: "agent_skills",
    source_id: id,
    owner_id: "test@example.com",
    visibility: "private",
    metadata: { is_system: false, category: "Custom" },
  };
}

function mongoSkill(id = MONGO_ID, name = SKILL_NAME): AgentSkill {
  return {
    id,
    name,
    description: name,
    category: "Custom",
    is_quick_start: true,
    is_system: false,
    owner_id: "test@example.com",
    visibility: "private",
    tasks: [{ display_text: "Do it", llm_prompt: "Do it", subagent: "user_input" }],
    created_at: new Date(),
    updated_at: new Date(),
  } as AgentSkill;
}

function requestUrl(input: string | URL | Request): string {
  return typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
}

const isCatalogUrl = (url: string | URL | Request) =>
  requestUrl(url).includes("/api/skills?include_content=true");

const okJson = (body: unknown) =>
  ({ ok: true, json: () => Promise.resolve(body) }) as Response;

const notOk = (status = 500) =>
  ({ ok: false, status, json: () => Promise.resolve({}) }) as Response;

async function renderGallery() {
  await act(async () => {
    render(<SkillsGallery onEditConfig={jest.fn()} onCreateNew={jest.fn()} />);
  });
}

async function deleteSkillViaDialog(index = 0) {
  fireEvent.click(screen.getAllByTitle("Delete")[index]);
  fireEvent.click(await screen.findByRole("button", { name: /^(Delete|Remove)$/ }));
}

// `hidden: true`: while the confirm dialog is open the gallery is aria-hidden.
const card = (name: string) => screen.queryByRole("heading", { name, hidden: true });

/** fetch mock whose catalog responses are produced by `onCatalog(callNumber)`. */
function mockCatalogFetch(onCatalog: (call: number) => Promise<Response>) {
  const state = { calls: 0 };
  global.fetch = jest.fn((url: string | URL | Request) => {
    if (isCatalogUrl(url)) {
      state.calls += 1;
      return onCatalog(state.calls);
    }
    return Promise.resolve(okJson({}));
  }) as jest.Mock;
  return state;
}

beforeEach(() => {
  jest.clearAllMocks();
  _configs = [mongoSkill()];
  mockDeleteSkill.mockImplementation(async () => {
    _configs = [];
  });
});

afterEach(() => {
  jest.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Unit: request-ordering guard in reloadCatalog
// ---------------------------------------------------------------------------

describe("SkillsGallery — reloadCatalog request ordering (unit)", () => {
  it("applies the newest response when an older request resolves after it", async () => {
    _configs = [mongoSkill("store-anchor", "store-anchor")];
    let resolveFirst: (res: Response) => void = () => {};
    const state = mockCatalogFetch((call) =>
      call === 1
        ? new Promise<Response>((resolve) => {
            resolveFirst = resolve;
          })
        : Promise.resolve(okJson({ skills: [catalogRow("cat-new", "catalog-new")] })),
    );

    await renderGallery();
    // Second request, started via the indicator's onScanComplete (-> refreshAll).
    await act(async () => {
      fireEvent.click(screen.getByTestId("scan-complete-store-anchor"));
    });
    await waitFor(() => expect(state.calls).toBe(2));
    expect(await screen.findByRole("heading", { name: "catalog-new" })).toBeInTheDocument();

    // The older request now resolves with different (stale) data.
    await act(async () => {
      resolveFirst(okJson({ skills: [catalogRow("cat-old", "catalog-old")] }));
    });

    expect(screen.getByRole("heading", { name: "catalog-new" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "catalog-old" })).not.toBeInTheDocument();
  });

  it("still applies a response when it is the latest request (no regression for normal loads)", async () => {
    mockCatalogFetch(() => Promise.resolve(okJson({ skills: [catalogRow("cat-a", "catalog-a")] })));

    await renderGallery();

    expect(await screen.findByRole("heading", { name: "catalog-a" })).toBeInTheDocument();
  });

  it("does not let a superseded request's failure or empty body clear newer data", async () => {
    _configs = [mongoSkill("store-anchor", "store-anchor")];
    let rejectFirst: (err: Error) => void = () => {};
    const state = mockCatalogFetch((call) =>
      call === 1
        ? new Promise<Response>((_, reject) => {
            rejectFirst = reject;
          })
        : Promise.resolve(okJson({ skills: [catalogRow("cat-new", "catalog-new")] })),
    );

    await renderGallery();
    await act(async () => {
      fireEvent.click(screen.getByTestId("scan-complete-store-anchor"));
    });
    await waitFor(() => expect(state.calls).toBe(2));
    expect(await screen.findByRole("heading", { name: "catalog-new" })).toBeInTheDocument();

    await act(async () => {
      rejectFirst(new Error("network down"));
    });

    expect(screen.getByRole("heading", { name: "catalog-new" })).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Unit: local catalog prune in confirmDelete
// ---------------------------------------------------------------------------

describe("SkillsGallery — confirmDelete catalog prune (unit)", () => {
  it("removes only the deleted skill and keeps unrelated catalog skills when the refresh fails", async () => {
    mockCatalogFetch((call) =>
      call === 1
        ? Promise.resolve(
            okJson({
              skills: [catalogRow(), catalogRow("other-skill", "other-skill")],
            }),
          )
        : Promise.resolve(notOk()),
    );

    await renderGallery();
    expect(screen.getByRole("heading", { name: "other-skill" })).toBeInTheDocument();

    await deleteSkillViaDialog(0);
    await waitFor(() => expect(mockDeleteSkill).toHaveBeenCalledWith(MONGO_ID));

    await waitFor(() => expect(card(SKILL_NAME)).not.toBeInTheDocument());
    expect(card("other-skill")).toBeInTheDocument();
  });

  it("closes the confirm dialog and shows no error toast when only the refresh fails", async () => {
    mockCatalogFetch((call) =>
      call === 1 ? Promise.resolve(okJson({ skills: [catalogRow()] })) : Promise.resolve(notOk(503)),
    );

    await renderGallery();
    await deleteSkillViaDialog();

    await waitFor(() => expect(mockDeleteSkill).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(mockToast).not.toHaveBeenCalledWith(expect.anything(), "error");
  });

  it("drops the skill when the post-delete refresh throws a network error", async () => {
    mockCatalogFetch((call) =>
      call === 1
        ? Promise.resolve(okJson({ skills: [catalogRow()] }))
        : Promise.reject(new Error("network down")),
    );

    await renderGallery();
    await deleteSkillViaDialog();

    await waitFor(() => expect(card(SKILL_NAME)).not.toBeInTheDocument());
  });

  it("does NOT prune the catalog and surfaces an error when deleteSkill itself fails", async () => {
    _configs = [mongoSkill()];
    mockDeleteSkill.mockImplementationOnce(async () => {
      throw new Error("delete exploded");
    });
    const state = mockCatalogFetch(() => Promise.resolve(okJson({ skills: [catalogRow()] })));

    await renderGallery();
    await deleteSkillViaDialog();

    await waitFor(() => expect(mockToast).toHaveBeenCalledWith("delete exploded", "error"));
    // No post-delete refresh, and the card is still there.
    expect(state.calls).toBe(1);
    expect(card(SKILL_NAME)).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Regression: the two scenarios from #3086
// ---------------------------------------------------------------------------

describe("SkillsGallery — deleted skill vs. catalog refresh (#3086 regression)", () => {
  it("ignores a superseded mount-time catalog response that resolves after the post-delete refresh", async () => {
    let resolveStale: (res: Response) => void = () => {};
    const state = mockCatalogFetch((call) =>
      call === 1
        ? // Mount-time request: read the catalog before the delete, resolves late.
          new Promise<Response>((resolve) => {
            resolveStale = resolve;
          })
        : // Post-delete refresh: the skill is gone.
          Promise.resolve(okJson({ skills: [] })),
    );

    await renderGallery();
    expect(screen.getByRole("heading", { name: SKILL_NAME })).toBeInTheDocument();

    await deleteSkillViaDialog();
    await waitFor(() => {
      expect(mockDeleteSkill).toHaveBeenCalledWith(MONGO_ID);
      expect(state.calls).toBe(2);
    });

    // The stale response now lands with the pre-delete catalog.
    await act(async () => {
      resolveStale(okJson({ skills: [catalogRow()] }));
    });

    expect(card(SKILL_NAME)).not.toBeInTheDocument();
  });

  it("keeps the card gone when the stale response resolves BEFORE the delete completes and the refresh then fails", async () => {
    const state = mockCatalogFetch((call) =>
      call === 1 ? Promise.resolve(okJson({ skills: [catalogRow()] })) : Promise.resolve(notOk()),
    );

    await renderGallery();
    await deleteSkillViaDialog();
    await waitFor(() => expect(state.calls).toBe(2));

    await waitFor(() => expect(card(SKILL_NAME)).not.toBeInTheDocument());
  });

  it("drops the deleted skill from the catalog even when the post-delete refresh returns non-OK", async () => {
    const state = mockCatalogFetch((call) =>
      call === 1 ? Promise.resolve(okJson({ skills: [catalogRow()] })) : Promise.resolve(notOk()),
    );

    // Mongo copy and catalog copy of the same skill dedupe to a single card.
    await renderGallery();
    expect(screen.getAllByRole("heading", { name: SKILL_NAME })).toHaveLength(1);

    await deleteSkillViaDialog();
    await waitFor(() => {
      expect(mockDeleteSkill).toHaveBeenCalledWith(MONGO_ID);
      expect(state.calls).toBe(2);
    });

    await waitFor(() => expect(card(SKILL_NAME)).not.toBeInTheDocument());
  });

  it("drops the deleted skill when the catalog refresh returns 200 without a skills array", async () => {
    mockCatalogFetch((call) =>
      call === 1 ? Promise.resolve(okJson({ skills: [catalogRow()] })) : Promise.resolve(okJson({})),
    );

    await renderGallery();
    await deleteSkillViaDialog();

    await waitFor(() => expect(card(SKILL_NAME)).not.toBeInTheDocument());
  });
});
