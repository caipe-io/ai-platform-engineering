# Tasks: App-Declared Message Actions in the Host Assistant

**Input**: `docs/docs/specs/2026-11-15-host-message-actions/` (plan, spec, research, data-model, contracts, quickstart)
**Tests**: Included. The spec's acceptance criteria require manifest, capability, BFF and UI tests.
**Paths**: All paths are repo-relative. Work happens in `ui/`.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: can run in parallel (different files, no unfinished dependency)
- **[Story]**: user story from `spec.md`

**Story order**: P1 stories first. US5 (server protection) comes before the UI stories because the UI calls the route, and the route must never exist without its checks.

| Story | Title | Priority |
|---|---|---|
| US5 | Host protects the app and the user | P1 |
| US1 | One-click action on a finished answer | P1 |
| US2 | Edit text in a dialog before submitting | P1 |
| US3 | App decides who sees each action | P2 |
| US4 | Developer declares actions and detects support | P2 |

---

## Phase 1: Setup

- [x] T001 Run the baseline and record it is green: `cd ui && npx jest src/lib/agentic-apps src/app/api/v1/chat src/components/agentic-apps src/components/chat`
- [x] T002 Resolve research R8 by reading `ui/src/lib/agentic-apps/proxy.ts`: can `proxyAgenticAppRequest` take a server-built `Request`, a 30 s abort signal and `redirect: "manual"`? Record the answer in `docs/docs/specs/2026-11-15-host-message-actions/research.md` under R8. If not, T011 adds an options argument.

---

## Phase 2: Foundational (blocks all stories)

**Purpose**: manifest declaration and configuration shapes that every story reads.

- [x] T003 Add `messageActions` to the `hostOptions` key allowlist and write `validateMessageActions` (max 4, `identifier()` ids, unique, label 1-24, host icon list, dialog fields, `maxLength` 1-60000) in `ui/app-sdk/assistant-options.mjs`, with the limits as named constants
- [x] T004 In `ui/app-sdk/agentic-app-manifest.mjs` (next to the `validateAssistantOptions` call near line 232), validate each action `path` with the same rules as `streamPath`: `pathValue`, starts with `/api/`, app declares a runtime, and an allowed `POST` policy covers it. Reject `messageActions` when `overlay` is `"app"`.
- [x] T005 [P] Extend `validateAssistantConfiguration` in `ui/app-sdk/assistant-options.mjs` to accept `messageActions: Record<id, { visible: boolean }>`; undeclared ids are accepted and ignored by the host (FR-009)
- [x] T006 [P] Add `MessageActionDeclaration`, `MessageActionDialog` and the `messageActions` configuration type to `ui/app-sdk/assistant-options.d.mts`. Re-export from `ui/app-sdk/index.d.ts`.

**Checkpoint**: a manifest with valid actions loads, an invalid one is rejected.

---

## Phase 3: US5 - Host protects the app and the user (P1)

**Goal**: a safe route that calls the app. **Independent test**: send requests directly to the route and check every refusal and the success path, with no UI.

- [x] T007 [P] [US5] Write route tests in `ui/src/app/api/v1/chat/assistant-actions/__tests__/route.test.ts`: 401 unauthenticated, 403 service account, 403/404 non-owner, 403 no agent-use, unknown action 404, client-supplied `path` ignored, agent mismatch 409, user message and unsaved message refused, over-size body 413, text over `maxLength` 400, empty required field 400, success proxy with correct body and identity, app error mapped to `{ error, code }`, non-JSON 502, timeout 504, redirect not followed, non-web-UI conversation 403
- [x] T008 [P] [US5] Write resolver tests in `ui/src/lib/agentic-apps/__tests__/assistant-actions.test.ts`: finds the action by agent and id, refuses a disabled or uninstalled app, never returns a client-supplied path, audit event has app id and action id and no text
- [x] T009 [US5] Create `ui/src/lib/agentic-apps/assistant-actions.ts` with `findAgenticAppMessageAction(agentId, actionId)`. It uses `getAgenticAppRoutingSnapshot()` the way `findAgenticAppAssistantStream` does.
- [x] T010 [US5] In `ui/src/lib/agentic-apps/assistant-actions.ts`, add `loadAssistantMessage(conversationId, messageId)`. It reads `messages` with `getCollection`, requires `role === "assistant"` and returns `metadata.turn_id`.
- [x] T011 [US5] In `ui/src/lib/agentic-apps/assistant-actions.ts`, add `callAgenticAppMessageAction(...)`. It builds the body `{ conversation_id, message_id, turn_id, action_id, text? }`, calls `proxyAgenticAppRequest` as the user with a 30 s timeout and no redirects, and requires `application/json`. It maps non-2xx to `{ error, code }` and other failures to fixed 502/504 messages. Per T002, no change to `proxy.ts`: pass a synthetic `Request` with `signal: AbortSignal.timeout(...)`. Keep the 30 s timeout as a named constant.
- [x] T012 [US5] In `ui/src/lib/agentic-apps/assistant-actions.ts`, write the audit event through `getAuditBackend().write()` with app id, action id, conversation id, subject and outcome. Copy field names from `ui/src/lib/rbac/audit.ts`. Never include text.
- [x] T013 [US5] Create `ui/src/app/api/v1/chat/assistant-actions/route.ts` (`runtime = "nodejs"`) that runs the check order in `contracts/bff-assistant-actions.md`. Use `authenticateChatStreamRequest`, `requireAgentUsePermission` and `authorizeConversationWriteAccess` as `stream/start/route.ts` does. Bound the body with `readBodyWithLimit`.
- [x] T014 [US5] Make T007 and T008 pass.

**Checkpoint**: the route is safe and complete without any UI.

---

## Phase 4: US1 - One-click action on a finished answer (P1)

**Goal**: a no-dialog action shows on finished assistant messages and calls the app. **Independent test**: declare one no-dialog action, enable it, finish an answer, click it.

- [x] T015 [P] [US1] Write component tests in `ui/src/components/chat/__tests__/MessageActionButtons.test.tsx`: pending state, success toast, app error text shown, button usable again after error, a second click while pending sends nothing, accessible name and `aria-busy`, a hung request ends in the error state after the abort, labels and dialog text render as plain text with no markup interpretation
- [x] T016 [P] [US1] Write panel tests in `ui/src/components/chat/__tests__/DynamicAgentChatPanel.messageActions.test.tsx`: actions show on a finished assistant message, not on a streaming one, not on a user message, not when the prop is empty
- [x] T017 [US1] Add `postAssistantAction(...)` to `ui/src/lib/api-client.ts` for `POST /api/v1/chat/assistant-actions`, with a 35 s abort (`ASSISTANT_ACTION_CLIENT_TIMEOUT_MS`) so a hung server still ends in an error state (SC-007)
- [x] T018 [US1] Create `ui/src/components/chat/MessageActionButtons.tsx`: icon button per action, pending, toast and error states, keyboard and screen-reader support, plain-text labels
- [x] T019 [US1] In `ui/src/components/chat/DynamicAgentChatPanel.tsx`, add a `messageActions` prop next to `feedbackPrompt` (line ~135). Render `MessageActionButtons` beside `FeedbackButton` (line ~3786) for finished assistant messages only.
- [x] T020 [US1] In `ui/src/components/agentic-apps/AgenticAppAssistantOverlay.tsx`, pass only actions that are declared and enabled in the configuration, and only for the app's own agent. Thread the prop through `ui/src/components/chat/DynamicAgentChatView.tsx` if the panel is wrapped there.
- [x] T021 [US1] Make T015 and T016 pass.

**Checkpoint**: quickstart steps 4-8 work for a no-dialog action.

---

## Phase 5: US2 - Edit text in a dialog before submitting (P1)

**Goal**: an action with a dialog opens an editable field. **Independent test**: declare a dialog action, edit the prefilled text, submit, check the app received the edit.

- [x] T022 [P] [US2] Add dialog tests to `ui/src/components/chat/__tests__/MessageActionButtons.test.tsx`: `prefill: "message"` fills the answer text, `prefill: "empty"` starts empty, edits are sent as `input.text`, required empty field blocks submit, text over `maxLength` blocks submit with a message, cancel sends nothing, focus is trapped and returned, Escape closes
- [x] T023 [US2] Add the dialog to `ui/src/components/chat/MessageActionButtons.tsx` using the shared dialog primitive from `ui/src/components/ui/`. Render title, description, field, submit label and a cancel button as plain text.
- [x] T024 [US2] Pass the answer text from `DynamicAgentChatPanel.tsx` to the dialog for prefill. Send the edited value as `input.text` through `postAssistantAction`.
- [x] T025 [US2] Make T022 pass.

**Checkpoint**: quickstart step 6 works with a dialog.

---

## Phase 6: US3 - App decides who sees each action (P2)

**Goal**: visibility is per user, hidden by default, reset on account change. **Independent test**: two users, one enabled.

- [x] T026 [P] [US3] Add configuration tests in new `ui/src/components/agentic-apps/__tests__/assistant-message-actions-config.test.ts`: undeclared id ignored, malformed id rejected, `visible: false` hides, missing entry hides
- [x] T027 [P] [US3] Write overlay tests in `ui/src/components/agentic-apps/__tests__/AgenticAppAssistantOverlay.test.tsx`: hidden until configured, shown after `configure`, cleared on unmount, cleared on account change
- [x] T028 [US3] In `ui/src/components/agentic-apps/AgenticAppAssistantOverlay.tsx` and `AgenticAppShell.tsx`, keep enablement in component state. Clear it on unmount and account change.
- [x] T029 [US3] In `ui/src/lib/agentic-apps/assistant-presentation.ts`, drop `messageActions` from the configuration before `rememberAssistantPresentation` stores it, and ignore it in `readAssistantPresentation`. The stored copy is shared across tabs for 5 minutes and must not make an action visible before the app calls `configure`. Add a test: after remember and read, `messageActions` is absent.
- [x] T030 [US3] In `ui/src/native-extensions/NativeExtensionAssistant.tsx` and `ui/src/native-extensions/host-chat.tsx`, validate `messageActions` in `configure()` with the shared validator
- [x] T031 [US3] Make T026 and T027 pass.

**Checkpoint**: quickstart step 9 works.

---

## Phase 7: US4 - Developer declares actions and detects support (P2)

**Goal**: apps can detect and use the feature, native or iframe. **Independent test**: valid and invalid manifests, and both capability reports.

- [x] T032 [P] [US4] Add manifest tests in new `ui/src/components/agentic-apps/__tests__/assistant-message-actions-manifest.test.ts`: valid declaration, unknown keys, duplicate ids, more than 4, bad ids, bad paths, oversize label, oversize `maxLength`, unknown icon, bad `prefill`
- [x] T033 [P] [US4] Add capability tests: native `HostAssistantCapability.extensions` and iframe `composerExtensions` both include `messageActions.v1` (`ui/src/components/agentic-apps/__tests__/AgenticAppShell.test.tsx` and a `host-chat` test beside `ui/src/native-extensions/`)
- [x] T034 [US4] Add `"messageActions.v1"` to `ASSISTANT_EXTENSIONS` in `ui/app-sdk/assistant-options.mjs`
- [x] T035 [US4] In `ui/app-sdk/iframe-bridge.mjs`, let `configureAssistant` carry `messageActions`. Throw if the host does not report `messageActions.v1`.
- [x] T036 [US4] Bump `CHECKER_VERSION` in `ui/app-sdk/contract-version.mjs` and `version` in `ui/app-sdk/package.json`. Leave `CONTRACT_VERSION` alone. Check `ui/app-sdk/bin/check-manifest.mjs` reports the new rules.
- [x] T037 [P] [US4] Document the feature in `ui/app-sdk/README.md` and new `docs/docs/ui/message-actions.md`: manifest example, capability check, `configure` example, endpoint request and response, and the note to require a host release with this feature. Use neutral names (`example-agent`, `example.test`).
- [x] T038 [US4] Make T032 and T033 pass.

**Checkpoint**: an app developer can follow the docs alone.

---

## Phase 8: Polish

- [x] T039 Run the full quickstart in `quickstart.md`, including the negative checks. Done against the demo app (`ui/examples/external-apps/actions-demo`): the real UI in headless Chrome and the real routes. Verified: stored message id matches, actions on fresh and reloaded answers, dialog prefill, edit and submit, app error text, length limit, Escape and focus return, per-user show and hide, 404, 409, 400, bad response, redirect, app 401 mapping, 30 s timeout. Not verifiable under the dev bypass: 401, service account, non-owner (unit tests cover them). Left for a person: visual polish, screen reader, Safari and Firefox, a real second user.
- [x] T040 Run `cd ui && npm run lint && npm run build` and the Jest paths from T001. Fix failures.
- [x] T041 Check that no real product, company or person names appear in code, tests, docs or fixtures (repo rule). Check that no audit event or log line contains action text.
- [x] T042 Confirm SC-008: an app with no `messageActions` renders and behaves as before. Add a regression assertion to `DynamicAgentChatPanel.messageActions.test.tsx`.

---

## Dependencies

```text
Setup (T001, T002)
  └─> Foundational (T003-T006)
        └─> US5 server (T007-T014)   [T011 needs T002]
              └─> US1 UI (T015-T021)
                    └─> US2 dialog (T022-T025)
        ├─> US3 visibility (T026-T031)   [T020 in US1 reads configuration; US3 adds reset]
        └─> US4 capability and docs (T032-T038)
                                      └─> Polish (T039-T042)
```

- US4 depends only on Foundational and can run in parallel with US1 and US2. US1 acceptance (T020) needs an enabled configuration, which Foundational T005 provides.
- US3 follows US1: T020 (US1) and T028 (US3) both edit `AgenticAppAssistantOverlay.tsx`.
- T003, T005 and T034 all edit `ui/app-sdk/assistant-options.mjs`: run them in that order, not in parallel.
- US2 extends the component from US1.

## Parallel examples

- Foundational: T005 and T006 together after T003.
- US5: T007 and T008 together. Then T009-T012 in order (same file).
- US1: T015 and T016 together.
- US3 and US4 tests: T026, T027, T032, T033 together.
- Docs T037 can start once T034 and T035 settle the names.

## Implementation strategy

- **MVP**: Setup, Foundational, US5, US1. This gives a safe one-click action. Enablement is stubbed by the existing configuration path, so use a test app that calls `configure`.
- **Next**: US2 (dialog). This completes the motivating use case.
- **Then**: US3 (per-user reset) and US4 (capability, bridge, docs, version). Do not release the feature to apps before US3 and US4 land, since apps need the capability check and the reset behavior.
- **PR size**: split into PRs by phase group (SDK and manifest; server; UI; docs). Keep each under about 500 hand-written lines.

## Counts

- Total: 42 tasks
- Setup 2, Foundational 4, US5 8, US1 7, US2 4, US3 6, US4 7, Polish 4
