/**
 * @jest-environment jsdom
 */
/**
 * Unit tests for agent-skills-store.ts
 *
 * Covers:
 * - Initial state, selectSkill, getSkillById, getSkillsByCategory
 * - loadSkills: success, 503/401 fallback, seedTemplates, loadFavorites
 * - createSkill, updateSkill, deleteSkill with error handling
 * - Favorites: toggleFavorite, isFavorite, getFavoriteSkills
 * - seedTemplates
 */

import { act } from "@testing-library/react";
import { useAgentSkillsStore } from "../agent-skills-store";
import type { AgentSkill, CreateAgentSkillInput } from "@/types/agent-skill";

// ============================================================================
// Mocks
// ============================================================================

const mockFetch = jest.fn();
const originalFetch = global.fetch;

beforeAll(() => {
  global.fetch = mockFetch;
});

afterAll(() => {
  global.fetch = originalFetch;
});

// ============================================================================
// Helpers
// ============================================================================

function resetStore() {
  useAgentSkillsStore.setState({
    configs: [],
    isLoading: false,
    error: null,
    selectedSkillId: null,
    isSeeded: false,
    favorites: [],
    favoritesLoaded: false,
  });
}

function makeConfig(overrides: Partial<AgentSkill> = {}): AgentSkill {
  return {
    id: `config-${Math.random().toString(36).slice(2, 9)}`,
    name: "Test Config",
    description: "Test description",
    category: "Custom",
    tasks: [
      { display_text: "Step 1", llm_prompt: "Do something", subagent: "user_input" },
    ],
    owner_id: "system",
    is_system: false,
    created_at: new Date("2024-01-01"),
    updated_at: new Date("2024-01-01"),
    ...overrides,
  };
}

/** Setup mocks for loadSkills to succeed (seed + favorites + agent-configs) */
function mockLoadConfigsSuccess(configs: Array<Record<string, unknown>> = []) {
  const configPayload = configs.map((c) => ({
    ...c,
    created_at:
      c.created_at instanceof Date
        ? c.created_at.toISOString()
        : (c.created_at as string),
    updated_at:
      c.updated_at instanceof Date
        ? c.updated_at.toISOString()
        : (c.updated_at as string),
  }));

  mockFetch.mockImplementation((url: string | URL, init?: RequestInit) => {
    const u = typeof url === "string" ? url : url.toString();
    if (u.includes("/api/skills/seed")) {
      if (init?.method === "POST") {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ seeded: 1 }),
        } as Response);
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ needsSeeding: false }),
      } as Response);
    }
    if (u.includes("/api/users/me/favorites")) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ data: { favorites: [] } }),
      } as Response);
    }
    if (u === "/api/skills/configs" && !init) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve(configPayload),
      } as Response);
    }
    return Promise.reject(new Error(`Unmocked: ${u}`));
  });
}

// ============================================================================
// Tests
// ============================================================================

describe("agent-skills-store", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resetStore();
  });

  // --------------------------------------------------------------------------
  // initial state
  // --------------------------------------------------------------------------

  describe("initial state", () => {
    it("configs is empty array", () => {
      expect(useAgentSkillsStore.getState().configs).toEqual([]);
    });

    it("isLoading is false", () => {
      expect(useAgentSkillsStore.getState().isLoading).toBe(false);
    });

    it("error is null", () => {
      expect(useAgentSkillsStore.getState().error).toBeNull();
    });

    it("selectedSkillId is null", () => {
      expect(useAgentSkillsStore.getState().selectedSkillId).toBeNull();
    });

    it("favorites is empty array", () => {
      expect(useAgentSkillsStore.getState().favorites).toEqual([]);
    });
  });

  // --------------------------------------------------------------------------
  // selectSkill
  // --------------------------------------------------------------------------

  describe("selectSkill", () => {
    it("sets selectedSkillId", () => {
      act(() => {
        useAgentSkillsStore.getState().selectSkill("config-123");
      });
      expect(useAgentSkillsStore.getState().selectedSkillId).toBe("config-123");
    });

    it("can set to null", () => {
      act(() => {
        useAgentSkillsStore.getState().selectSkill("config-123");
      });
      act(() => {
        useAgentSkillsStore.getState().selectSkill(null);
      });
      expect(useAgentSkillsStore.getState().selectedSkillId).toBeNull();
    });
  });

  // --------------------------------------------------------------------------
  // getSkillById
  // --------------------------------------------------------------------------

  describe("getSkillById", () => {
    it("returns config when found", () => {
      const config = makeConfig({ id: "found-id", name: "Found Config" });
      useAgentSkillsStore.setState({ configs: [config] });

      const result = useAgentSkillsStore.getState().getSkillById("found-id");
      expect(result).toBeDefined();
      expect(result?.name).toBe("Found Config");
    });

    it("returns undefined when not found", () => {
      const result = useAgentSkillsStore.getState().getSkillById("nonexistent");
      expect(result).toBeUndefined();
    });
  });

  // --------------------------------------------------------------------------
  // getSkillsByCategory
  // --------------------------------------------------------------------------

  describe("getSkillsByCategory", () => {
    it("returns matching configs", () => {
      const c1 = makeConfig({ id: "c1", category: "DevOps" });
      const c2 = makeConfig({ id: "c2", category: "DevOps" });
      const c3 = makeConfig({ id: "c3", category: "Custom" });
      useAgentSkillsStore.setState({ configs: [c1, c2, c3] });

      const result = useAgentSkillsStore.getState().getSkillsByCategory("DevOps");
      expect(result).toHaveLength(2);
      expect(result.map((c) => c.id)).toContain("c1");
      expect(result.map((c) => c.id)).toContain("c2");
    });

    it("returns empty when no match", () => {
      useAgentSkillsStore.setState({
        configs: [makeConfig({ category: "DevOps" })],
      });

      const result = useAgentSkillsStore.getState().getSkillsByCategory("Custom");
      expect(result).toEqual([]);
    });
  });

  // --------------------------------------------------------------------------
  // loadSkills
  // --------------------------------------------------------------------------

  describe("loadSkills", () => {
    it("sets isLoading during fetch", async () => {
      let resolveConfigs!: (response: Response) => void;
      const pending = new Promise<Response>((resolve) => { resolveConfigs = resolve; });
      mockLoadConfigsSuccess([]);
      const usualFetch = mockFetch.getMockImplementation();
      mockFetch.mockImplementation((url, init) => url === "/api/skills/configs"
        ? pending : usualFetch!(url, init));
      const loadPromise = act(async () => {
        await useAgentSkillsStore.getState().loadSkills();
      });
      expect(useAgentSkillsStore.getState().isLoading).toBe(true);
      resolveConfigs({ ok: true, json: async () => [] } as unknown as Response);
      await loadPromise;
      expect(useAgentSkillsStore.getState().isLoading).toBe(false);
    });

    it("stores transformed configs on success", async () => {
      const rawConfigs = [
        {
          id: "api-1",
          name: "From API",
          category: "DevOps",
          tasks: [{ display_text: "Step", llm_prompt: "Do it", subagent: "user_input" }],
          owner_id: "user",
          is_system: false,
          created_at: "2024-06-01T00:00:00Z",
          updated_at: "2024-06-01T00:00:00Z",
        },
      ];

      mockLoadConfigsSuccess(rawConfigs);

      await act(async () => {
        await useAgentSkillsStore.getState().loadSkills();
      });

      const configs = useAgentSkillsStore.getState().configs;
      expect(configs).toHaveLength(1);
      expect(configs[0].id).toBe("api-1");
      expect(configs[0].created_at).toBeInstanceOf(Date);
      expect(configs[0].updated_at).toBeInstanceOf(Date);
    });

    it("handles 503 - returns empty configs", async () => {
      mockFetch.mockImplementation((url: string | URL) => {
        const u = typeof url === "string" ? url : url.toString();
        if (u.includes("/api/skills/seed")) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ needsSeeding: false }),
          } as Response);
        }
        if (u.includes("/api/users/me/favorites")) {
          return Promise.resolve({
            status: 503,
            ok: false,
          } as Response);
        }
        if (u === "/api/skills/configs") {
          return Promise.resolve({
            status: 503,
            ok: false,
          } as Response);
        }
        return Promise.reject(new Error(`Unmocked: ${u}`));
      });

      await act(async () => {
        await useAgentSkillsStore.getState().loadSkills();
      });

      expect(useAgentSkillsStore.getState().configs).toEqual([]);
    });

    it("handles 401 - returns empty configs", async () => {
      mockFetch.mockImplementation((url: string | URL) => {
        const u = typeof url === "string" ? url : url.toString();
        if (u.includes("/api/skills/seed")) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ needsSeeding: false }),
          } as Response);
        }
        if (u.includes("/api/users/me/favorites")) {
          return Promise.resolve({ status: 401, ok: false } as Response);
        }
        if (u === "/api/skills/configs") {
          return Promise.resolve({ status: 401, ok: false } as Response);
        }
        return Promise.reject(new Error(`Unmocked: ${u}`));
      });

      await act(async () => {
        await useAgentSkillsStore.getState().loadSkills();
      });

      expect(useAgentSkillsStore.getState().configs).toEqual([]);
    });

    it("handles error - returns empty configs", async () => {
      mockFetch.mockImplementation((url: string | URL) => {
        const u = typeof url === "string" ? url : url.toString();
        if (u.includes("/api/skills/seed")) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ needsSeeding: false }),
          } as Response);
        }
        if (u.includes("/api/users/me/favorites")) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ data: { favorites: [] } }),
          } as Response);
        }
        if (u === "/api/skills/configs") {
          return Promise.reject(new Error("Network error"));
        }
        return Promise.reject(new Error(`Unmocked: ${u}`));
      });

      await act(async () => {
        await useAgentSkillsStore.getState().loadSkills();
      });

      expect(useAgentSkillsStore.getState().configs).toEqual([]);
    });

    it("does not seed templates while loading skills", async () => {
      mockFetch.mockImplementation((url: string | URL, init?: RequestInit) => {
        const u = typeof url === "string" ? url : url.toString();
        if (u.includes("/api/skills/seed")) {
          if (init?.method === "POST") {
            return Promise.resolve({
              ok: true,
              json: () => Promise.resolve({ seeded: 2 }),
            } as Response);
          }
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ needsSeeding: true }),
          } as Response);
        }
        if (u.includes("/api/users/me/favorites")) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ data: { favorites: [] } }),
          } as Response);
        }
        if (u === "/api/skills/configs") {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve([]),
          } as Response);
        }
        return Promise.reject(new Error(`Unmocked: ${u}`));
      });

      await act(async () => {
        await useAgentSkillsStore.getState().loadSkills();
      });

      const seedCalls = mockFetch.mock.calls.filter((call) =>
        String(call[0]).includes("/api/skills/seed")
      );
      expect(seedCalls).toHaveLength(0);
    });

    it("calls loadFavorites if not loaded", async () => {
      mockLoadConfigsSuccess([]);

      await act(async () => {
        await useAgentSkillsStore.getState().loadSkills();
      });

      const favoritesCalls = mockFetch.mock.calls.filter((call) =>
        String(call[0]).includes("/api/users/me/favorites")
      );
      expect(favoritesCalls.length).toBeGreaterThanOrEqual(1);
    });
  });

  // --------------------------------------------------------------------------
  // createSkill
  // --------------------------------------------------------------------------

  describe("createSkill", () => {
    const createInput: CreateAgentSkillInput = {
      name: "New Workflow",
      description: "A new workflow",
      category: "Custom",
      tasks: [{ display_text: "Step", llm_prompt: "Do it", subagent: "user_input" }],
    };

    it("sends POST request", async () => {
      mockFetch.mockImplementation((url: string | URL, init?: RequestInit) => {
        const u = typeof url === "string" ? url : url.toString();
        if (u === "/api/skills/configs" && init?.method === "POST") {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ id: "new-id-123" }),
          } as Response);
        }
        if (u === "/api/skills/configs" && !init) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve([{ id: "new-id-123", ...createInput, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), owner_id: "user", is_system: false }]),
          } as Response);
        }
        return Promise.reject(new Error(`Unmocked: ${u}`));
      });

      let createdId: string | undefined;
      await act(async () => {
        createdId = await useAgentSkillsStore.getState().createSkill(createInput);
      });

      expect(mockFetch).toHaveBeenCalledWith(
        "/api/skills/configs",
        expect.objectContaining({
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(createInput),
        })
      );
      expect(createdId).toBe("new-id-123");
    });

    it("unwraps the success-envelope { data: { id } } shape returned by the API", async () => {
      // Regression: the POST route returns successResponse() →
      // { success: true, data: { id } }. Reading result.id directly yielded
      // `undefined`, which navigated callers to /skills/workspace/undefined.
      mockFetch.mockImplementation((url: string | URL, init?: RequestInit) => {
        const u = typeof url === "string" ? url : url.toString();
        if (u === "/api/skills/configs" && init?.method === "POST") {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({ success: true, data: { id: "wrapped-id-456" } }),
          } as Response);
        }
        if (u === "/api/skills/configs" && !init) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve([]),
          } as Response);
        }
        return Promise.reject(new Error(`Unmocked: ${u}`));
      });

      let createdId: string | undefined;
      await act(async () => {
        createdId = await useAgentSkillsStore.getState().createSkill(createInput);
      });

      expect(createdId).toBe("wrapped-id-456");
    });

    it("throws when the API response carries no skill id", async () => {
      mockFetch.mockImplementation((url: string | URL, init?: RequestInit) => {
        const u = typeof url === "string" ? url : url.toString();
        if (u === "/api/skills/configs" && init?.method === "POST") {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ success: true, data: {} }),
          } as Response);
        }
        return Promise.reject(new Error(`Unmocked: ${u}`));
      });

      await expect(
        act(async () => {
          await useAgentSkillsStore.getState().createSkill(createInput);
        })
      ).rejects.toThrow("no skill id");
    });

    it("reloads configs after creation", async () => {
      let callCount = 0;
      mockFetch.mockImplementation((url: string | URL, init?: RequestInit) => {
        const u = typeof url === "string" ? url : url.toString();
        if (u === "/api/skills/configs" && init?.method === "POST") {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ id: "created-id" }),
          } as Response);
        }
        if (u === "/api/skills/configs" && !init) {
          callCount++;
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve([
                {
                  id: "created-id",
                  name: "New",
                  category: "Custom",
                  tasks: [],
                  owner_id: "user",
                  is_system: false,
                  created_at: new Date().toISOString(),
                  updated_at: new Date().toISOString(),
                },
              ]),
          } as Response);
        }
        return Promise.reject(new Error(`Unmocked: ${u}`));
      });

      await act(async () => {
        await useAgentSkillsStore.getState().createSkill(createInput);
      });

      expect(callCount).toBeGreaterThanOrEqual(1);
      expect(useAgentSkillsStore.getState().configs).toHaveLength(1);
    });

    it("handles 503 error", async () => {
      mockFetch.mockResolvedValue({ status: 503, ok: false } as Response);

      await expect(
        act(async () => {
          await useAgentSkillsStore.getState().createSkill(createInput);
        })
      ).rejects.toThrow("MongoDB is required");
    });

    it("handles 401 error", async () => {
      mockFetch.mockResolvedValue({ status: 401, ok: false } as Response);

      await expect(
        act(async () => {
          await useAgentSkillsStore.getState().createSkill(createInput);
        })
      ).rejects.toThrow("Please sign in");
    });

    it("handles generic error", async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
        json: () => Promise.resolve({ error: "Server error" }),
      } as Response);

      await expect(
        act(async () => {
          await useAgentSkillsStore.getState().createSkill(createInput);
        })
      ).rejects.toThrow();
    });
  });

  // --------------------------------------------------------------------------
  // updateSkill
  // --------------------------------------------------------------------------

  describe("updateSkill", () => {
    it("sends PUT request with id in query", async () => {
      mockFetch.mockImplementation((url: string | URL, init?: RequestInit) => {
        const u = typeof url === "string" ? url : url.toString();
        if (u.includes("/api/skills/configs?id=cfg-1") && init?.method === "PUT") {
          return Promise.resolve({ ok: true } as Response);
        }
        if (u === "/api/skills/configs") {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve([]),
          } as Response);
        }
        return Promise.reject(new Error(`Unmocked: ${u}`));
      });

      await act(async () => {
        await useAgentSkillsStore
          .getState()
          .updateSkill("cfg-1", { name: "Updated Name" });
      });

      expect(mockFetch).toHaveBeenCalledWith(
        "/api/skills/configs?id=cfg-1",
        expect.objectContaining({
          method: "PUT",
          body: JSON.stringify({ name: "Updated Name" }),
        })
      );
    });

    it("reloads configs after update", async () => {
      mockFetch.mockImplementation((url: string | URL, init?: RequestInit) => {
        const u = typeof url === "string" ? url : url.toString();
        if (u.includes("id=cfg-1") && init?.method === "PUT") {
          return Promise.resolve({ ok: true } as Response);
        }
        if (u === "/api/skills/configs") {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve([
                {
                  id: "cfg-1",
                  name: "Updated",
                  category: "Custom",
                  tasks: [],
                  owner_id: "user",
                  is_system: false,
                  created_at: new Date().toISOString(),
                  updated_at: new Date().toISOString(),
                },
              ]),
          } as Response);
        }
        return Promise.reject(new Error(`Unmocked: ${u}`));
      });

      await act(async () => {
        await useAgentSkillsStore
          .getState()
          .updateSkill("cfg-1", { name: "Updated" });
      });

      expect(useAgentSkillsStore.getState().configs[0]?.name).toBe("Updated");
    });

    it("handles 503, 401 errors", async () => {
      mockFetch.mockResolvedValue({ status: 503, ok: false } as Response);

      await expect(
        act(async () => {
          await useAgentSkillsStore
            .getState()
            .updateSkill("cfg-1", { name: "X" });
        })
      ).rejects.toThrow("MongoDB is required");

      mockFetch.mockResolvedValue({ status: 401, ok: false } as Response);

      await expect(
        act(async () => {
          await useAgentSkillsStore
            .getState()
            .updateSkill("cfg-1", { name: "X" });
        })
      ).rejects.toThrow("Please sign in");
    });
  });

  // --------------------------------------------------------------------------
  // deleteSkill
  // --------------------------------------------------------------------------

  describe("deleteSkill", () => {
    it("sends DELETE request", async () => {
      mockFetch.mockImplementation((url: string | URL) => {
        const u = typeof url === "string" ? url : url.toString();
        if (u.includes("/api/skills/configs?id=del-1")) {
          return Promise.resolve({ ok: true } as Response);
        }
        if (u === "/api/skills/configs") {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve([]),
          } as Response);
        }
        return Promise.reject(new Error(`Unmocked: ${u}`));
      });

      await act(async () => {
        await useAgentSkillsStore.getState().deleteSkill("del-1");
      });

      expect(mockFetch).toHaveBeenCalledWith(
        "/api/skills/configs?id=del-1",
        expect.objectContaining({ method: "DELETE" })
      );
    });

    it("reloads configs after delete", async () => {
      const remainingConfig = {
        id: "keep-1",
        name: "Remaining",
        category: "Custom",
        tasks: [],
        owner_id: "user",
        is_system: false,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };

      mockFetch.mockImplementation((url: string | URL) => {
        const u = typeof url === "string" ? url : url.toString();
        if (u.includes("id=del-1")) {
          return Promise.resolve({ ok: true } as Response);
        }
        if (u === "/api/skills/configs") {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve([remainingConfig]),
          } as Response);
        }
        return Promise.reject(new Error(`Unmocked: ${u}`));
      });

      await act(async () => {
        await useAgentSkillsStore.getState().deleteSkill("del-1");
      });

      // Store reloads from API; when API returns configs, we get them (not built-in templates)
      expect(useAgentSkillsStore.getState().configs).toHaveLength(1);
      expect(useAgentSkillsStore.getState().configs[0].id).toBe("keep-1");
    });

    it("clears selectedSkillId if deleted config was selected", async () => {
      useAgentSkillsStore.setState({ selectedSkillId: "selected-to-delete" });

      mockFetch.mockImplementation((url: string | URL) => {
        const u = typeof url === "string" ? url : url.toString();
        if (u.includes("id=selected-to-delete")) {
          return Promise.resolve({ ok: true } as Response);
        }
        if (u === "/api/skills/configs") {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve([]),
          } as Response);
        }
        return Promise.reject(new Error(`Unmocked: ${u}`));
      });

      await act(async () => {
        await useAgentSkillsStore.getState().deleteSkill("selected-to-delete");
      });

      expect(useAgentSkillsStore.getState().selectedSkillId).toBeNull();
    });

    it("handles 503, 401 errors", async () => {
      mockFetch.mockResolvedValue({ status: 503, ok: false } as Response);

      await expect(
        act(async () => {
          await useAgentSkillsStore.getState().deleteSkill("x");
        })
      ).rejects.toThrow("MongoDB is required");

      mockFetch.mockResolvedValue({ status: 401, ok: false } as Response);

      await expect(
        act(async () => {
          await useAgentSkillsStore.getState().deleteSkill("x");
        })
      ).rejects.toThrow("Please sign in");
    });
  });

  // --------------------------------------------------------------------------
  // favorites
  // --------------------------------------------------------------------------

  describe("favorites", () => {
    it("toggleFavorite adds new favorite", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({}),
      } as Response);

      await act(async () => {
        await useAgentSkillsStore.getState().toggleFavorite("fav-1");
      });

      expect(useAgentSkillsStore.getState().favorites).toContain("fav-1");
    });

    it("toggleFavorite removes existing favorite", async () => {
      useAgentSkillsStore.setState({ favorites: ["fav-1", "fav-2"] });
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({}),
      } as Response);

      await act(async () => {
        await useAgentSkillsStore.getState().toggleFavorite("fav-1");
      });

      expect(useAgentSkillsStore.getState().favorites).not.toContain("fav-1");
      expect(useAgentSkillsStore.getState().favorites).toContain("fav-2");
    });

    it("isFavorite returns true for favorited config", () => {
      useAgentSkillsStore.setState({ favorites: ["fav-a"] });

      expect(useAgentSkillsStore.getState().isFavorite("fav-a")).toBe(true);
    });

    it("isFavorite returns false for non-favorited", () => {
      expect(useAgentSkillsStore.getState().isFavorite("non-fav")).toBe(false);
    });

    it("getFavoriteSkills returns only favorited configs", () => {
      const c1 = makeConfig({ id: "fav-1", name: "Fav 1" });
      const c2 = makeConfig({ id: "fav-2", name: "Fav 2" });
      const c3 = makeConfig({ id: "not-fav", name: "Not Fav" });
      useAgentSkillsStore.setState({
        configs: [c1, c2, c3],
        favorites: ["fav-1", "fav-2"],
      });

      const result = useAgentSkillsStore.getState().getFavoriteSkills();
      expect(result).toHaveLength(2);
      expect(result.map((c) => c.id).sort()).toEqual(["fav-1", "fav-2"]);
    });

    it("getFavoriteSkills deduplicates", () => {
      const c1 = makeConfig({ id: "dup-id", name: "Dup" });
      useAgentSkillsStore.setState({
        configs: [c1],
        favorites: ["dup-id", "dup-id"],
      });

      const result = useAgentSkillsStore.getState().getFavoriteSkills();
      expect(result).toHaveLength(1);
    });
  });

  // --------------------------------------------------------------------------
  // seedTemplates
  // --------------------------------------------------------------------------

  describe("seedTemplates", () => {
    it("skips POST when GET returns needsSeeding false", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ needsSeeding: false }),
      } as Response);

      await act(async () => {
        await useAgentSkillsStore.getState().seedTemplates();
      });

      // Only GET should be called, no POST
      const postCalls = mockFetch.mock.calls.filter(
        (call) => (call[1] as RequestInit)?.method === "POST"
      );
      expect(postCalls).toHaveLength(0);
    });

    it("checks seed status via GET", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ needsSeeding: false }),
      } as Response);

      await act(async () => {
        await useAgentSkillsStore.getState().seedTemplates();
      });

      expect(mockFetch).toHaveBeenCalledWith("/api/skills/seed");
    });

    it("seeds via POST when needed", async () => {
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ needsSeeding: true }),
        } as Response)
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ seeded: 11 }),
        } as Response);

      await act(async () => {
        await useAgentSkillsStore.getState().seedTemplates();
      });

      const postCalls = mockFetch.mock.calls.filter(
        (call) => (call[1] as RequestInit)?.method === "POST"
      );
      expect(postCalls.length).toBeGreaterThanOrEqual(1);
      expect(useAgentSkillsStore.getState().isSeeded).toBe(true);
    });
  });
});
