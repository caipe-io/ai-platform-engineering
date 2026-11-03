/**
 * Regression tests for #3086: a deleted skill must not reappear in the
 * SkillsGallery after (1) an out-of-order catalog response or (2) a failed
 * post-delete catalog refresh.
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
  useToast: () => ({ toast: jest.fn() }),
}));

jest.mock("../SkillScanStatusIndicator", () => ({
  __esModule: true,
  SkillScanStatusIndicator: () => <span data-testid="scan-indicator" />,
}));

const MONGO_ID = "skill-delete-3086";
const SKILL_NAME = "to-delete-3086";

function catalogRow() {
  return {
    id: MONGO_ID,
    name: SKILL_NAME,
    description: SKILL_NAME,
    source: "agent_skills",
    source_id: MONGO_ID,
    owner_id: "test@example.com",
    visibility: "private",
    metadata: { is_system: false, category: "Custom" },
  };
}

function mongoSkill(): AgentSkill {
  return {
    id: MONGO_ID,
    name: SKILL_NAME,
    description: SKILL_NAME,
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

async function renderGallery() {
  await act(async () => {
    render(<SkillsGallery onEditConfig={jest.fn()} onCreateNew={jest.fn()} />);
  });
}

async function deleteSkillViaDialog() {
  fireEvent.click(screen.getAllByTitle("Delete")[0]);
  fireEvent.click(await screen.findByRole("button", { name: /^(Delete|Remove)$/ }));
}

const isCatalogUrl = (url: string | URL | Request) =>
  requestUrl(url).includes("/api/skills?include_content=true");

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

describe("SkillsGallery — deleted skill vs. catalog refresh (#3086)", () => {
  it("ignores a superseded mount-time catalog response that resolves after the post-delete refresh", async () => {
    let catalogCalls = 0;
    let resolveStale: (res: Response) => void = () => {};

    global.fetch = jest.fn((url: string | URL | Request) => {
      if (isCatalogUrl(url)) {
        catalogCalls += 1;
        if (catalogCalls === 1) {
          // Mount-time request: read the catalog before the delete, resolves late.
          return new Promise<Response>((resolve) => {
            resolveStale = resolve;
          });
        }
        // Post-delete refresh: the skill is gone.
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ skills: [] }) } as Response);
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) } as Response);
    }) as jest.Mock;

    await renderGallery();
    expect(screen.getByRole("heading", { name: SKILL_NAME })).toBeInTheDocument();

    await deleteSkillViaDialog();
    await waitFor(() => {
      expect(mockDeleteSkill).toHaveBeenCalledWith(MONGO_ID);
      expect(catalogCalls).toBe(2);
    });

    // The stale response now lands with the pre-delete catalog.
    await act(async () => {
      resolveStale({ ok: true, json: () => Promise.resolve({ skills: [catalogRow()] }) } as Response);
    });

    expect(screen.queryByRole("heading", { name: SKILL_NAME, hidden: true })).not.toBeInTheDocument();
  });

  it("drops the deleted skill from the catalog even when the post-delete refresh fails", async () => {
    let catalogCalls = 0;

    global.fetch = jest.fn((url: string | URL | Request) => {
      if (isCatalogUrl(url)) {
        catalogCalls += 1;
        if (catalogCalls === 1) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ skills: [catalogRow()] }),
          } as Response);
        }
        // Post-delete refresh fails with a non-OK response.
        return Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({}) } as Response);
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) } as Response);
    }) as jest.Mock;

    // Mongo copy and catalog copy of the same skill dedupe to a single card.
    await renderGallery();
    expect(screen.getAllByRole("heading", { name: SKILL_NAME })).toHaveLength(1);

    await deleteSkillViaDialog();
    await waitFor(() => {
      expect(mockDeleteSkill).toHaveBeenCalledWith(MONGO_ID);
      expect(catalogCalls).toBe(2);
    });

    await waitFor(() => {
      expect(screen.queryByRole("heading", { name: SKILL_NAME, hidden: true })).not.toBeInTheDocument();
    });
  });
});
