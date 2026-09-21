import { getErrorMessage } from "@/lib/error-utils";
import type {
AgentSkill,
AgentSkillCategory,
CreateAgentSkillInput,
UpdateAgentSkillInput,
} from "@/types/agent-skill";
import { create } from "zustand";

/**
 * Agent Skills Store
 * 
 * Manages editable skills for the Skills Gallery and Dynamic Agents picker.
 * Skill definitions use MongoDB so they remain persistent and shareable.
 * 
 * On first load, automatically seeds MongoDB with built-in templates.
 */

interface AgentSkillsState {
  configs: AgentSkill[];
  isLoading: boolean;
  error: string | null;
  selectedSkillId: string | null;
  isSeeded: boolean;
  favorites: string[]; // Array of config IDs
  favoritesLoaded: boolean; // Track if favorites have been loaded from MongoDB

  // Actions
  loadSkills: () => Promise<void>;
  loadFavorites: () => Promise<void>;
  createSkill: (config: CreateAgentSkillInput) => Promise<string>;
  updateSkill: (id: string, updates: UpdateAgentSkillInput) => Promise<void>;
  deleteSkill: (id: string) => Promise<void>;
  selectSkill: (id: string | null) => void;
  getSkillById: (id: string) => AgentSkill | undefined;
  getSkillsByCategory: (category: AgentSkillCategory | string) => AgentSkill[];
  importFromYaml: (yamlContent: string) => Promise<string[]>;
  refreshSkills: () => Promise<void>;
  seedTemplates: () => Promise<void>;
  toggleFavorite: (id: string) => Promise<void>;
  isFavorite: (id: string) => boolean;
  getFavoriteSkills: () => AgentSkill[];
}

// Transform API response to ensure proper date handling
type SerializedAgentSkill = Omit<AgentSkill, "created_at" | "updated_at"> & {
  created_at: Date | string;
  updated_at: Date | string;
};

function transformSkill(config: SerializedAgentSkill): AgentSkill {
  return {
    ...config,
    created_at: new Date(config.created_at),
    updated_at: new Date(config.updated_at),
  };
}

// Favorites helpers
const FAVORITES_STORAGE_KEY = "agent-skills-favorites";
const FAVORITES_MIGRATED_KEY = "agent-skills-favorites-migrated";

/**
 * Load favorites from localStorage (fallback only)
 */
function loadFavoritesFromLocalStorage(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const stored = localStorage.getItem(FAVORITES_STORAGE_KEY);
    return stored ? JSON.parse(stored) : [];
  } catch (error) {
    console.error("[AgentSkillsStore] Failed to load favorites from localStorage:", error);
    return [];
  }
}

/**
 * Save favorites to localStorage (fallback only)
 */
function saveFavoritesToLocalStorage(favorites: string[]): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(FAVORITES_STORAGE_KEY, JSON.stringify(favorites));
  } catch (error) {
    console.error("[AgentSkillsStore] Failed to save favorites to localStorage:", error);
  }
}

/**
 * Load favorites from MongoDB
 */
async function loadFavoritesFromMongoDB(): Promise<string[]> {
  try {
    const response = await fetch("/api/users/me/favorites");
    
    // Handle 503 (MongoDB not configured) - use localStorage
    if (response.status === 503) {
      console.log("[AgentSkillsStore] MongoDB not configured, using localStorage for favorites");
      return loadFavoritesFromLocalStorage();
    }
    
    // Handle 401 (not authenticated) - use localStorage
    if (response.status === 401) {
      console.log("[AgentSkillsStore] Not authenticated, using localStorage for favorites");
      return loadFavoritesFromLocalStorage();
    }
    
    if (!response.ok) {
      throw new Error(`Failed to load favorites: ${response.status}`);
    }
    
    const result = await response.json();
    // API returns { success: true, data: { favorites: [...] } }
    const favorites = result.data?.favorites || [];
    console.log(`[AgentSkillsStore] Loaded ${favorites.length} favorites from MongoDB`);
    return favorites;
  } catch (error) {
    console.error("[AgentSkillsStore] Failed to load favorites from MongoDB:", error);
    // Fallback to localStorage
    return loadFavoritesFromLocalStorage();
  }
}

/**
 * Save favorites to MongoDB
 */
async function saveFavoritesToMongoDB(favorites: string[]): Promise<boolean> {
  try {
    const response = await fetch("/api/users/me/favorites", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ favorites }),
    });
    
    // Handle 503 (MongoDB not configured) - use localStorage
    if (response.status === 503) {
      console.log("[AgentSkillsStore] MongoDB not configured, using localStorage for favorites");
      saveFavoritesToLocalStorage(favorites);
      return false;
    }
    
    // Handle 401 (not authenticated) - use localStorage
    if (response.status === 401) {
      console.log("[AgentSkillsStore] Not authenticated, using localStorage for favorites");
      saveFavoritesToLocalStorage(favorites);
      return false;
    }
    
    if (!response.ok) {
      throw new Error(`Failed to save favorites: ${response.status}`);
    }
    
    console.log(`[AgentSkillsStore] Saved ${favorites.length} favorites to MongoDB`);
    return true;
  } catch (error) {
    console.error("[AgentSkillsStore] Failed to save favorites to MongoDB:", error);
    // Fallback to localStorage
    saveFavoritesToLocalStorage(favorites);
    return false;
  }
}

/**
 * Migrate favorites from localStorage to MongoDB (one-time)
 */
async function migrateFavoritesToMongoDB(): Promise<void> {
  if (typeof window === "undefined") return;
  
  // Check if already migrated
  const alreadyMigrated = localStorage.getItem(FAVORITES_MIGRATED_KEY);
  if (alreadyMigrated) {
    return;
  }
  
  // Get favorites from localStorage
  const localFavorites = loadFavoritesFromLocalStorage();
  
  if (localFavorites.length === 0) {
    // No favorites to migrate, mark as migrated
    localStorage.setItem(FAVORITES_MIGRATED_KEY, "true");
    return;
  }
  
  console.log(`[AgentSkillsStore] Migrating ${localFavorites.length} favorites from localStorage to MongoDB...`);
  
  // Save to MongoDB
  const success = await saveFavoritesToMongoDB(localFavorites);
  
  if (success) {
    // Mark as migrated
    localStorage.setItem(FAVORITES_MIGRATED_KEY, "true");
    console.log(`[AgentSkillsStore] Successfully migrated ${localFavorites.length} favorites to MongoDB`);
  }
}

export const useAgentSkillsStore = create<AgentSkillsState>()((set, get) => ({
  configs: [],
  isLoading: false,
  error: null,
  selectedSkillId: null,
  isSeeded: false,
  favorites: [], // Will be loaded from MongoDB
  favoritesLoaded: false,

  /**
   * Seed built-in templates to MongoDB
   */
  seedTemplates: async () => {
    try {
      // Check if seeding is needed
      const checkResponse = await fetch("/api/skills/seed");
      if (!checkResponse.ok) {
        console.log("[AgentSkillsStore] Seed check failed, skipping");
        return;
      }
      
      const status = await checkResponse.json();
      if (!status.needsSeeding) {
        console.log("[AgentSkillsStore] Templates already seeded");
        set({ isSeeded: true });
        return;
      }
      
      // Perform seeding
      console.log("[AgentSkillsStore] Seeding built-in templates...");
      const seedResponse = await fetch("/api/skills/seed", {
        method: "POST",
      });
      
      if (seedResponse.ok) {
        const result = await seedResponse.json();
        console.log(`[AgentSkillsStore] Seeded ${result.seeded} templates`);
        set({ isSeeded: true });
      }
    } catch (error) {
      console.log("[AgentSkillsStore] Seeding skipped:", error);
    }
  },

  loadFavorites: async () => {
    // Migrate favorites from localStorage to MongoDB (one-time)
    await migrateFavoritesToMongoDB();
    
    // Load favorites from MongoDB
    const favorites = await loadFavoritesFromMongoDB();
    set({ favorites, favoritesLoaded: true });
    console.log(`[AgentSkillsStore] Loaded ${favorites.length} favorites`);
  },

  loadSkills: async () => {
    set({ isLoading: true, error: null });

    try {
      // First, try to seed templates if not already done
      if (!get().isSeeded) {
        await get().seedTemplates();
      }
      
      // Load favorites if not already loaded
      if (!get().favoritesLoaded) {
        await get().loadFavorites();
      }
      
      const response = await fetch("/api/skills/configs");
      
      // Handle 503 (MongoDB not configured) gracefully
      if (response.status === 503) {
        console.log("[AgentSkillsStore] MongoDB not configured");
        set({ configs: [], isLoading: false });
        return;
      }

      // Handle 401 (not authenticated) gracefully
      if (response.status === 401) {
        console.log("[AgentSkillsStore] Not authenticated");
        set({ configs: [], isLoading: false });
        return;
      }
      
      if (!response.ok) {
        const error = await response.json().catch(() => ({ error: "Failed to fetch agent skills" }));
        throw new Error(error.error || `HTTP ${response.status}`);
      }
      
      const data = await response.json();
      const transformed = data.map(transformSkill);

      set({ configs: transformed, isLoading: false });
      console.log(`[AgentSkillsStore] Loaded ${transformed.length} agent skills from MongoDB`);
    } catch (error) {
      console.error("[AgentSkillsStore] Failed to load configs:", error);
      set({ configs: [], isLoading: false });
    }
  },

  createSkill: async (skillData) => {
    try {
      const response = await fetch("/api/skills/configs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(skillData),
      });

      // Handle 503 (MongoDB not configured)
      if (response.status === 503) {
        throw new Error("MongoDB is required to save custom workflows. Please configure MongoDB.");
      }
      
      // Handle 401 (not authenticated)
      if (response.status === 401) {
        throw new Error("Please sign in to save custom workflows.");
      }

      if (!response.ok) {
        const error = await response.json().catch(() => ({ error: "Failed to create agent skill" }));
        throw new Error(error.error || "Failed to create agent skill");
      }

      const result = await response.json();

      // POST /api/skills/configs returns the success-envelope shape
      // ({ success, data: { id } }) via successResponse(); older/unwrapped
      // shapes return { id } at the top level. Accept either so navigation
      // to /skills/workspace/<id> never receives `undefined`.
      const createdId: string | undefined = result?.data?.id ?? result?.id;
      if (!createdId) {
        throw new Error("Create succeeded but no skill id was returned");
      }

      // Reload from server to get the created config
      await get().loadSkills();
      console.log(`[AgentSkillsStore] Created agent skill "${skillData.name}"`);

      return createdId;
    } catch (error) {
      console.error("[AgentSkillsStore] Failed to create config:", error);
      throw error;
    }
  },

  updateSkill: async (id, updates) => {
    try {
      console.log(`[AgentSkillsStore] Updating config ${id} with:`, updates);
      
      const response = await fetch(`/api/skills/configs?id=${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(updates),
      });

      // Handle 503 (MongoDB not configured)
      if (response.status === 503) {
        throw new Error("MongoDB is required to update workflows. Please configure MongoDB.");
      }
      
      // Handle 401 (not authenticated)
      if (response.status === 401) {
        throw new Error("Please sign in to update workflows.");
      }

      if (!response.ok) {
        const error = await response.json().catch(() => ({ error: "Failed to update agent skill" }));
        throw new Error(error.error || "Failed to update agent skill");
      }

      // Reload from server
      await get().loadSkills();
      
      // Log the updated config
      const updatedSkill = get().configs.find(c => c.id === id);
      console.log(`[AgentSkillsStore] Updated agent skill "${id}"`);
      console.log(`[AgentSkillsStore] Reloaded config:`, updatedSkill);
    } catch (error) {
      console.error("[AgentSkillsStore] Failed to update config:", error);
      throw error;
    }
  },

  deleteSkill: async (id) => {
    try {
      const response = await fetch(`/api/skills/configs?id=${id}`, {
        method: "DELETE",
      });

      // Handle 503 (MongoDB not configured)
      if (response.status === 503) {
        throw new Error("MongoDB is required to delete workflows. Please configure MongoDB.");
      }
      
      // Handle 401 (not authenticated)
      if (response.status === 401) {
        throw new Error("Please sign in to delete workflows.");
      }

      if (!response.ok) {
        const error = await response.json().catch(() => ({ error: "Failed to delete agent skill" }));
        throw new Error(error.error || "Failed to delete agent skill");
      }

      // Reload from server
      await get().loadSkills();
      
      // Clear selection if deleted config was selected
      if (get().selectedSkillId === id) {
        set({ selectedSkillId: null });
      }
      
      console.log(`[AgentSkillsStore] Deleted agent skill "${id}"`);
    } catch (error) {
      console.error("[AgentSkillsStore] Failed to delete config:", error);
      throw error;
    }
  },

  selectSkill: (id) => {
    set({ selectedSkillId: id });
  },

  getSkillById: (id) => {
    return get().configs.find((c) => c.id === id);
  },

  getSkillsByCategory: (category) => {
    return get().configs.filter((c) => c.category === category);
  },

  importFromYaml: async (yamlContent) => {
    // Dynamic import of yaml parser
    const { parse } = await import("yaml");
    
    try {
      const parsed = parse(yamlContent);
      const createdIds: string[] = [];
      
      // Parse the task_config.yaml format
      for (const [name, value] of Object.entries(parsed)) {
        if (typeof value !== "object" || !value || !("tasks" in value)) {
          console.warn(`[AgentSkillsStore] Skipping invalid entry: ${name}`);
          continue;
        }
        
        const skillValue = value as { tasks: Array<{ display_text: string; llm_prompt: string; subagent: string }> };
        
        // Infer category from name
        let category: AgentSkillCategory | string = "Custom";
        const nameLower = name.toLowerCase();
        if (nameLower.includes("github") || nameLower.includes("repo")) {
          category = "GitHub Operations";
        } else if (nameLower.includes("aws") || nameLower.includes("ec2") || nameLower.includes("eks") || nameLower.includes("s3")) {
          category = "AWS Operations";
        } else if (nameLower.includes("argocd") || nameLower.includes("deploy")) {
          category = "ArgoCD Operations";
        } else if (nameLower.includes("llm") || nameLower.includes("api key") || nameLower.includes("aigateway") || nameLower.includes("spend")) {
          category = "AI Gateway Operations";
        } else if (nameLower.includes("group") || nameLower.includes("user") || nameLower.includes("invite")) {
          category = "Group Management";
        }
        
        // Extract env vars from prompts
        const envVarPattern = /\$\{([A-Z_][A-Z0-9_]*)\}/g;
        const envVars = new Set<string>();
        skillValue.tasks.forEach((task) => {
          let match;
          while ((match = envVarPattern.exec(task.llm_prompt)) !== null) {
            envVars.add(match[1]);
          }
        });
        
        const skillInput: CreateAgentSkillInput = {
          name,
          description: `Workflow for: ${name}`,
          category,
          tasks: skillValue.tasks.map((task) => ({
            display_text: task.display_text,
            llm_prompt: task.llm_prompt,
            subagent: task.subagent,
          })),
          metadata: {
            env_vars_required: Array.from(envVars),
            schema_version: "1.0",
          },
        };
        
        const id = await get().createSkill(skillInput);
        createdIds.push(id);
      }
      
      console.log(`[AgentSkillsStore] Imported ${createdIds.length} configs from YAML`);
      return createdIds;
    } catch (error) {
      console.error("[AgentSkillsStore] Failed to import YAML:", error);
      throw new Error(`Failed to parse YAML: ${getErrorMessage(error, "")}`);
    }
  },

  refreshSkills: async () => {
    await get().loadSkills();
  },

  toggleFavorite: async (id) => {
    const favorites = get().favorites;
    const newFavorites = favorites.includes(id)
      ? favorites.filter((fid) => fid !== id)
      : [...favorites, id];
    
    // Optimistically update UI
    set({ favorites: newFavorites });
    console.log(`[AgentSkillsStore] Toggled favorite: ${id} (${newFavorites.length} total)`);
    
    // Save to MongoDB (fallback to localStorage if MongoDB fails)
    await saveFavoritesToMongoDB(newFavorites);
  },

  isFavorite: (id) => {
    return get().favorites.includes(id);
  },

  getFavoriteSkills: () => {
    const favorites = get().favorites;
    const configs = get().configs;
    
    // Deduplicate by id (in case there are duplicates)
    const seen = new Set<string>();
    const favoriteSkills = configs.filter((config) => {
      if (!favorites.includes(config.id)) return false;
      if (seen.has(config.id)) return false;
      seen.add(config.id);
      return true;
    });
    
    return favoriteSkills;
  },
}));
