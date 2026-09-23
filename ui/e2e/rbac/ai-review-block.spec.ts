// assisted-by claude:claude-sonnet-4-6
/**
 * Playwright tests for PR #1866 — AI Review failure UX in the agent editor.
 *
 * When a blocking AI Review fails, the editor surfaces an inline blocking
 * banner (buildBlockingMessage) — not a toast — and gates navigation:
 *   1. On the Instructions step ("Next" gate): inline banner shown, user stays
 *      on Instructions.
 *   2. On a later step ("Save" gate): editor navigates back to Instructions,
 *      inline banner updated to point there.
 *
 * These are mocked-RBAC browser regressions. Set RUN_RBAC_REGRESSION=1 to run.
 */

import { expect, test, type Page } from "@playwright/test";
import {
  fulfillJson,
  installMockedRbacApp,
  mockedRbacEnabled,
} from "./_mocked-rbac";

// ---------------------------------------------------------------------------
// Fixtures / helpers
// ---------------------------------------------------------------------------

const BLOCKING_REVIEW_CONFIG = {
  target: "agent-system-prompt",
  enabled: true,
  enforcement: "blocking",
  // min_score + grade_thresholds are required by the blocking gate: the editor
  // calls buildBlockingMessage() → scoreToGrade(min_score, grade_thresholds)
  // when a blocking review fails, which throws if either is missing.
  min_score: 0.8,
  grade_thresholds: { A: 0.9, B: 0.8, C: 0.7, D: 0.6 },
  criteria: [
    {
      id: "crit-1",
      label: "No placeholder text",
      description: "Prompt must not contain TODO or placeholder content.",
    },
  ],
};

const FAILED_REVIEW_RESULT = {
  target: "agent-system-prompt",
  passed: false,
  enforcement: "blocking",
  grade: "F",
  score: 0,
  hash: "abc123",
  total: 1,
  passed_count: 0,
  model: { id: "claude-sonnet-4-6", provider: "anthropic" },
  criteria: [
    {
      id: "crit-1",
      name: "No placeholder text",
      severity: "error",
      weight: 1,
      pass: false,
      comment: "System prompt contains placeholder text.",
      anchor: null,
      suggested_fix: null,
      error: null,
    },
  ],
};

async function installEditorMocks(page: Page): Promise<void> {
  await installMockedRbacApp(page, {
    isAdmin: true,
    handlers: [
      async ({ route, path, method }) => {
        // Models list — return one model so the editor does not block on missing model
        if (path === "/api/dynamic-agents/models" && method === "GET") {
          await fulfillJson(route, {
            success: true,
            data: [
              {
                id: "claude-sonnet-4-6",
                model_id: "claude-sonnet-4-6",
                name: "Claude Sonnet 4.6",
                provider: "anthropic",
                available: true,
              },
            ],
          });
          return true;
        }

        // Existing agent IDs — empty so no ID clash
        if (path === "/api/dynamic-agents" && method === "GET") {
          await fulfillJson(route, {
            success: true,
            data: { items: [], total: 0, page: 1, page_size: 100, has_more: false },
          });
          return true;
        }

        // Teams list
        if (path === "/api/dynamic-agents/teams" && method === "GET") {
          await fulfillJson(route, {
            success: true,
            data: [
              {
                _id: "team-1",
                slug: "platform",
                name: "Platform Team",
                can_own_agents: true,
                user_role: "admin",
              },
            ],
          });
          return true;
        }

        // MCP tool picker — the editor's Tools step expects a paginated list shape
        if (path === "/api/mcp-servers" && method === "GET") {
          await fulfillJson(route, {
            success: true,
            data: { items: [], total: 0, page: 1, page_size: 100, has_more: false },
          });
          return true;
        }

        // Blocking review config for the system-prompt target
        if (path === "/api/review-configs/agent-system-prompt" && method === "GET") {
          await fulfillJson(route, BLOCKING_REVIEW_CONFIG);
          return true;
        }

        // AI Review endpoint — always returns a failing result
        if (path === "/api/ai/review" && method === "POST") {
          await fulfillJson(route, { success: true, data: FAILED_REVIEW_RESULT });
          return true;
        }

        return false;
      },
    ],
  });
}

/** Open the New Agent editor from the dynamic-agents page. */
async function openNewAgentEditor(page: Page): Promise<void> {
  await page.goto("/dynamic-agents?tab=agents", { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: /new agent/i }).click();
  // Wait for the editor heading to confirm it's mounted
  await expect(page.getByText(/step 1/i)).toBeVisible({ timeout: 10_000 });
}

/**
 * Fill the Basic Info step (minimum required fields) and advance to Instructions.
 * We do NOT use the AI Review-gated "Next" button from Instructions here — that's
 * what the test under examination exercises. Instead we rely on the step indicator
 * to jump directly to Instructions after Basic Info is filled.
 */
async function fillBasicInfoAndGoToInstructions(page: Page): Promise<void> {
  // Fill agent name on Basic Info (step 1)
  await page.getByLabel(/agent name/i).fill("Playwright Test Agent");

  // Select model — click the combobox and pick the first option
  const modelSelect = page.getByRole("combobox", { name: "LLM Model" });
  // assisted-by Codex Codex-sonnet-4-6
  // The editor may render this as a native <select>; native <option> elements
  // are not visible/clickable in Chromium, so use selectOption when possible.
  if ((await modelSelect.evaluate((node) => node instanceof HTMLSelectElement))) {
    await modelSelect.selectOption({ index: 0 });
  } else {
    await modelSelect.click();
    await page.getByRole("listbox").getByRole("option").first().click();
  }

  // Pick an ownable owner team through the real TeamPicker; new agents cannot
  // be saved without this product-required ownership field.
  await page.getByLabel(/owner team/i).click();
  await page.getByRole("option", { name: /Platform Team.*team:platform/i }).click();

  // Click the Instructions step in the step indicator to jump directly
  await page.getByRole("button", { name: /^2\s+Instructions$/i }).click();
  await expect(page.getByRole("heading", { name: /Step 2: Instructions/i })).toBeVisible({
    timeout: 5_000,
  });
}

async function fillSystemPrompt(page: Page, value: string): Promise<void> {
  // CodeMirror exposes the editable surface as an unnamed contenteditable textbox.
  const editor = page.locator(".cm-content[contenteditable='true']").first();
  await expect(editor).toBeVisible({ timeout: 10_000 });
  await editor.fill(value);
  await expect(editor).toContainText(value);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe("AI Review failure UX — blocking review (PR #1866)", () => {
  test.beforeEach(() => {
    test.skip(
      !mockedRbacEnabled(),
      "Set RUN_RBAC_REGRESSION=1 to run the mocked RBAC browser regression.",
    );
  });

  test("blocking banner shows and user stays on Instructions when Next is blocked by a failing review", async ({
    page,
  }) => {
    await installEditorMocks(page);
    await openNewAgentEditor(page);
    await fillBasicInfoAndGoToInstructions(page);

    // Type something in the system prompt so the review can run (non-empty content)
    await fillSystemPrompt(page, "TODO: add real instructions here");

    // Click Next — this triggers `goToNextStep`, which calls `ensurePassedOrRun`
    await page.getByRole("button", { name: /^next$/i }).click();

    // 1. The user must still be on the Instructions step (not Tools)
    await expect(page.getByRole("heading", { name: /Step 2: Instructions/i })).toBeVisible();
    await expect(page.getByRole("heading", { name: /Step 3: Tools/i })).not.toBeVisible();

    // 2. Inline blocking banner is shown in the editor. The editor gates
    //    Next/Save behind a passing review with an inline message built by
    //    buildBlockingMessage() — not a toast.
    await expect(
      page.locator("form").getByText(/address the comments in the comments below before continuing/i),
    ).toBeVisible();
  });

  test("blocking banner shows and editor navigates to Instructions when Save is blocked from a later step", async ({
    page,
  }) => {
    await installEditorMocks(page);
    await openNewAgentEditor(page);
    await fillBasicInfoAndGoToInstructions(page);

    await fillSystemPrompt(page, "TODO: add real instructions here");

    // Move past Instructions to Tools by clicking the step indicator directly
    // (bypassing the Next gate — simulating a user who pre-passed review then
    // moved on, or who navigated via the step pill after a prior pass)
    await page.getByRole("button", { name: /^3\s+Tools$/i }).click();
    await expect(page.getByRole("heading", { name: /Step 3: Tools/i })).toBeVisible({
      timeout: 5_000,
    });

    // Attempt Save from the Tools step
    const saveButton = page.getByRole("button", { name: /save changes|create agent/i });
    await saveButton.click();

    // 1. Editor must have navigated back to the Instructions step
    await expect(page.getByRole("heading", { name: /Step 2: Instructions/i })).toBeVisible({
      timeout: 5_000,
    });
    await expect(page.getByRole("heading", { name: /Step 3: Tools/i })).not.toBeVisible();

    // 2. Inline blocking banner references the Instructions step. The save gate
    //    surfaces an inline message from buildBlockingMessage() — not a toast.
    await expect(
      page.locator("form").getByText(/instructions step before saving/i),
    ).toBeVisible();
  });
});
