/**
 * E2E: multimodal file input rides the chat composer through to the stream.
 *
 * Scope — transport + comprehension of ATTACHMENTS, exercised through a real
 * browser composer and the real streaming adapter:
 *   1. staging a file via the paperclip picker shows an attachment chip,
 *   2. sending emits ONE `/api/v1/chat/stream/start` POST whose body carries
 *      `files: [{ mime_type, data(base64), name }]` matching the picked file,
 *   3. a text-only turn omits `files` entirely (byte-identical to before),
 *   4. the mocked assistant reply renders in the transcript, and
 *   5. the uploaded file stays in the transcript — an image renders as an inline
 *      `data:` thumbnail, a non-image as a document chip bearing its name.
 *
 * The backend/model is mocked (SSE), so this is deterministic and CI-safe. The
 * end-to-end "model actually reads the file" proof lives in the live
 * validation script (tests/fixtures/multimodal/validate_multimodal.sh); the
 * seam serialization is unit-tested in
 * ui/src/lib/streaming/__tests__/adapter-files-payload.test.ts. This spec is
 * the browser-level glue between the two.
 *
 * Deliberately NOT asserted here: composer thumbnail fidelity and cross-reload
 * DB persistence of the attachment (covered by the store-level path, not this
 * mocked-backend browser spec).
 */

import { expect, test, type Page, type Route } from "@playwright/test";
import { resolve } from "node:path";

import {
  dismissReleaseUpgradeDialog,
  expectChatComposerReady,
  installChatBootMocks,
  installTestSession,
} from "./_helpers";
import { mockedRbacEnabled } from "./_mocked-rbac";

const CHAT_AGENT_ID = "agent-multimodal-e2e";
const CHAT_CONVERSATION_ID = "chat-multimodal-e2e-conv";
const USER_EMAIL = "multimodal-e2e@caipe.local";

const FIXTURE_DIR = resolve(__dirname, "..", "..", "..", "tests", "fixtures", "multimodal");
const FIXTURES = {
  txt: { path: resolve(FIXTURE_DIR, "sample.txt"), name: "sample.txt", mime: "text/plain" },
  jpeg: { path: resolve(FIXTURE_DIR, "sample.jpeg"), name: "sample.jpeg", mime: "image/jpeg" },
  pdf: { path: resolve(FIXTURE_DIR, "sample.pdf"), name: "sample.pdf", mime: "application/pdf" },
} as const;

type StreamFile = { mime_type?: string; data?: string; name?: string };
type StreamStartPayload = {
  message?: string;
  conversation_id?: string;
  agent_id?: string;
  protocol?: string;
  files?: StreamFile[];
};

function minimalSessionEnv() {
  return {
    baseUrl: process.env.CAIPE_UI_BASE_URL ?? "http://localhost:3000",
    keycloakUrl: process.env.KEYCLOAK_URL ?? "http://localhost:7080",
    keycloakRealm: process.env.KEYCLOAK_REALM ?? "caipe",
    user: { email: USER_EMAIL, password: "" },
  };
}

/** A minimal AG-UI success stream so the send resolves and renders a reply. */
async function fulfillSuccessStream(route: Route): Promise<void> {
  await route.fulfill({
    status: 200,
    contentType: "text/event-stream",
    headers: { "Cache-Control": "no-cache" },
    body: [
      'event: RUN_STARTED\ndata: {"runId":"multimodal-e2e-run"}\n\n',
      'event: TEXT_MESSAGE_START\ndata: {"messageId":"assistant-1"}\n\n',
      'event: TEXT_MESSAGE_CONTENT\ndata: {"delta":"Received your attachment."}\n\n',
      'event: TEXT_MESSAGE_END\ndata: {"messageId":"assistant-1"}\n\n',
      'event: RUN_FINISHED\ndata: {"outcome":"success"}\n\n',
    ].join(""),
  });
}

async function installMultimodalMocks(
  page: Page,
  streamStartRequests: StreamStartPayload[],
): Promise<void> {
  const env = minimalSessionEnv();

  await installChatBootMocks(page, env, {
    conversationId: CHAT_CONVERSATION_ID,
    ownerEmail: USER_EMAIL,
    agentId: CHAT_AGENT_ID,
    title: "Multimodal Input E2E",
  });

  await page.route("**/api/dynamic-agents**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const method = route.request().method();
    const agent = {
      _id: CHAT_AGENT_ID,
      name: "Multimodal Agent",
      description: "Mocked agent for multimodal input regressions",
      enabled: true,
      ui: {},
    };

    if (path === "/api/dynamic-agents/available" && method === "GET") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ success: true, data: [agent] }),
      });
      return;
    }
    if (path === `/api/dynamic-agents/agents/${CHAT_AGENT_ID}` && method === "GET") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ success: true, data: agent }),
      });
      return;
    }
    if (path === "/api/dynamic-agents" && method === "GET") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ success: true, data: { items: [agent], total: 1, page: 1, page_size: 20 } }),
      });
      return;
    }
    if (
      path === `/api/dynamic-agents/conversations/${CHAT_CONVERSATION_ID}/interrupt-state` &&
      method === "GET"
    ) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ success: true, data: { interrupted: false } }),
      });
      return;
    }
    await route.continue();
  });

  await page.route("**/api/v1/chat/stream/start", async (route) => {
    if (route.request().method() !== "POST") {
      await route.continue();
      return;
    }
    streamStartRequests.push(JSON.parse(route.request().postData() ?? "{}"));
    await fulfillSuccessStream(route);
  });

  await installTestSession(page, env, {
    email: USER_EMAIL,
    subject: "playwright-multimodal-sub",
    role: "user",
  });
}

async function openComposer(page: Page): Promise<void> {
  await page.goto(`/chat/${CHAT_CONVERSATION_ID}`, { waitUntil: "domcontentloaded" });
  await dismissReleaseUpgradeDialog(page);
  await expectChatComposerReady(page);
}

/** Stage a fixture on the hidden native picker the paperclip button drives. */
async function stageAttachment(page: Page, fixturePath: string): Promise<void> {
  await page.locator('input[type="file"]').setInputFiles(fixturePath);
}

/**
 * Assert an <img> actually decoded, not just that the element is in the DOM.
 * `toBeVisible()` passes for a broken-image icon (the element is laid out even
 * when the source failed to load), so it would not catch a revoked object URL
 * or a bad data URI. `naturalWidth > 0` is only true once the bytes decoded.
 */
async function expectImageDecoded(locator: import("@playwright/test").Locator): Promise<void> {
  await expect(locator).toBeVisible({ timeout: 10_000 });
  await expect
    .poll(async () => locator.evaluate((el) => (el as HTMLImageElement).naturalWidth), {
      timeout: 10_000,
    })
    .toBeGreaterThan(0);
}

test.describe("mocked RBAC e2e — chat multimodal input", () => {
  test.beforeEach(() => {
    test.skip(
      !mockedRbacEnabled(),
      "Set RUN_RBAC_E2E=1 (or RUN_RBAC_REGRESSION=1) to run the multimodal input e2e.",
    );
    test.skip(!process.env.NEXTAUTH_SECRET, "NEXTAUTH_SECRET required for chat SSR session.");
  });

  for (const [label, fixture] of Object.entries(FIXTURES)) {
    test(`attaches a ${label} file and sends it as multimodal input`, async ({ page }) => {
      const streamStartRequests: StreamStartPayload[] = [];
      await installMultimodalMocks(page, streamStartRequests);
      await openComposer(page);

      await stageAttachment(page, fixture.path);

      // The staged attachment surfaces as a chip before send.
      await expect(page.getByText(fixture.name, { exact: false })).toBeVisible({ timeout: 10_000 });

      // For images, the composer chip must show a real (decoded) thumbnail, not
      // a broken-image icon — regression guard for the revoked object-URL bug.
      if (label === "jpeg") {
        await expectImageDecoded(page.locator('img[src^="blob:"]').first());
        await page.screenshot({
          path: test.info().outputPath(`multimodal-${label}-composer-chip.png`),
          fullPage: true,
        });
      }

      const composer = page.getByRole("textbox", { name: "Message" });
      await composer.fill(`What is in this ${label} file?`);
      await composer.press("Enter");

      await expect.poll(() => streamStartRequests.length).toBe(1);

      const payload = streamStartRequests[0];
      expect(payload).toMatchObject({
        message: `What is in this ${label} file?`,
        conversation_id: CHAT_CONVERSATION_ID,
        agent_id: CHAT_AGENT_ID,
      });
      expect(Array.isArray(payload.files)).toBe(true);
      expect(payload.files).toHaveLength(1);

      const sent = payload.files![0];
      expect(sent.name).toBe(fixture.name);
      expect(sent.mime_type).toBe(fixture.mime);
      // base64 data is present and non-trivial (the file actually rode along).
      expect(typeof sent.data).toBe("string");
      expect((sent.data ?? "").length).toBeGreaterThan(16);

      // The mocked assistant reply renders, proving the turn completed.
      await expect(page.getByText(/Received your attachment\./i)).toBeVisible({ timeout: 15_000 });

      // The upload stays in the transcript (Erik's fix). Images render as an
      // inline data-URL thumbnail; other files as a document chip with the name.
      if (label === "jpeg") {
        const thumb = page.locator(`img[src^="data:${fixture.mime};base64,"]`);
        await expectImageDecoded(thumb.first());
      } else {
        // The filename appears twice once staged+sent (composer chip cleared on
        // send, transcript chip remains); assert at least one is visible.
        await expect(page.getByText(fixture.name, { exact: false }).first()).toBeVisible({
          timeout: 10_000,
        });
      }

      // Capture a labeled artifact for the image case (attaches to the PR).
      if (label === "jpeg") {
        await page.screenshot({
          path: test.info().outputPath(`multimodal-${label}-sent.png`),
          fullPage: true,
        });
      }
    });
  }

  test("a text-only turn omits files (byte-identical to a no-attachment send)", async ({ page }) => {
    const streamStartRequests: StreamStartPayload[] = [];
    await installMultimodalMocks(page, streamStartRequests);
    await openComposer(page);

    const composer = page.getByRole("textbox", { name: "Message" });
    await composer.fill("plain text, no attachment");
    await composer.press("Enter");

    await expect.poll(() => streamStartRequests.length).toBe(1);
    expect(streamStartRequests[0]).not.toHaveProperty("files");
    await expect(page.getByText(/Received your attachment\./i)).toBeVisible({ timeout: 15_000 });
  });
});
