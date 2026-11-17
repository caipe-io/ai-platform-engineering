# Research: App-Declared Message Actions

All technical unknowns are resolved. Findings come from the current code in `ui/`.

## R1. Where declarations live

- **Decision**: `ui.assistant.hostOptions.messageActions`, validated in `validateAssistantOptions` (`ui/app-sdk/assistant-options.mjs`).
- **Rationale**: `hostOptions` already carries host-rendered options and flows to the panel, native hosts and the iframe capability. Its `object(value, keys)` helper gives the strict key allowlist the spec needs.
- **Alternatives**: a new top-level `ui.assistant` key (needs a second validator path in `agentic-app-manifest.mjs`); a runtime-only message (violates FR-005).

## R2. Endpoint path rules

- **Decision**: `path` is app-relative and uses the same rules as `streamPath` and its siblings (`agentic-app-manifest.mjs`, lines ~219-246 and ~378).
- **Rationale**: Reuses the shape checks and the rules the manifest applies to `streamPath`: path starts with `/api/`, the app declares a runtime, and an allowed `POST` policy covers the path. The BFF splits it the way `findAgenticAppAssistantStream` does (`path.slice(1).split("/")`).
- **Alternatives**: a full URL (opens SSRF risk); an action-name-only mapping (adds an indirection with no gain).

## R3. Capability detection

- **Decision**: Add `"messageActions.v1"` to `ASSISTANT_EXTENSIONS`.
- **Rationale**: That list already feeds `HostAssistantCapability.extensions` (native, `host-chat.tsx`) and `composerExtensions` (iframe, `AgenticAppShell.tsx`). One edit covers both.
- **Alternatives**: a separate capability flag (two places to keep in sync).

## R4. Per-user visibility

- **Decision**: Extend `AssistantConfiguration` with `messageActions?: Record<actionId, { visible: boolean }>`. Validate in `validateAssistantConfiguration`: ids must be declared. Hidden until configured. Reset on unmount and account change.
- **Rationale**: `configure()` and `configureAssistant()` already deliver per-user state. `assistant-presentation.ts` already remembers configuration per app, agent and session, so account change handling has a place to hook in.
- **Presentation memory**: `assistant-presentation.ts` stores configuration in `localStorage` for 5 minutes, shared across tabs. It must exclude `messageActions`, or an action could show before the app calls `configure`.
- **Alternatives**: server-evaluated visibility (needs a new per-action policy hook; out of scope); a persistent flag (stale after role changes).

## R5. Server route shape

- **Decision**: New `POST /api/v1/chat/assistant-actions`. Do not add an `action` value to `AssistantStreamOperation`.
- **Rationale**: The existing operations are stream or status operations with an SSE-or-JSON check and a Webex path. Message actions are one JSON round trip with different authorization (message-level). A separate route avoids coupling to `dispatchChatStream`. The auth chain is reused as-is: `authenticateChatStreamRequest`, `requireAgentUsePermission`, `authorizeConversationWriteAccess`.
- **Alternatives**: Add an `action` operation to `proxyAgenticAppAssistantStream`. The source proposal uses this wording. Rejected here because that function is stream-centric and `dispatchChatStream` would route unrelated pinned-harness logic. The behavior is the same either way. Tasks may revisit if reviewers prefer one entry point.

## R6. Resolving the app, agent and action

- **Decision**: Match the installed app by `ui.assistant.agentId === agent_id` through `getAgenticAppRoutingSnapshot()` as `findAgenticAppAssistantStream` does. Require installed and enabled. Require `agent_id` to equal the conversation's saved agent (`getAgentId(conversation)`). Look up the action by id in that app's `hostOptions.messageActions`.
- **Rationale**: Same trust root as the stream. The client never supplies a path or app id.

## R7. Verifying the message and reading `turn_id`

- **Decision**: Load the stored message by `conversation_id` and `message_id` from `messages`. Require `role === "assistant"`. Read `metadata.turn_id`. A message that is not yet persisted is refused.
- **Rationale**: `Message` has `message_id`, `role` and `metadata.turn_id` (`ui/src/types/mongodb.ts`). A message in storage has finished streaming. The UI hides actions while streaming, and the stored check is the server-side backstop.
- **Alternatives**: trust the client's `turn_id` (spoofable); check the live run state (not available for all runtimes).

## R8. Calling the app

- **Decision**: Call `proxyAgenticAppRequest` with the resolved `{ appId, path }`, the user's `authenticatedUser`, and a JSON body built by the server. Wrap it with a 30 s `AbortSignal` and a response check: `content-type` must be `application/json`, redirects not followed.
- **Rationale**: This keeps the user identity, token minting and `readBodyWithLimit` limits already used for the stream. `BLOCKED_RESPONSE_HEADERS` already drops `location`.
- **Resolved (T002)**: `proxyAgenticAppRequest` accepts any `Request`. It already sets `redirect: "manual"` and aborts on `request.signal`. No change to `proxy.ts`. Build a synthetic `POST` request with only `content-type: application/json` (no browser cookies or headers), the server-made body, and `signal: AbortSignal.timeout(30000)`. Strip the query string from its URL.
- **Policy**: the proxy also requires an allowed `POST` policy for the path and an app runtime. The manifest validator must enforce the same, as it does for `streamPath`.

## R9. Error mapping

- **Decision**: App non-2xx with a JSON body returns `{ error, code }`. Other failures return fixed messages with 502 (bad response) or 504 (timeout). Never echo raw upstream bodies.
- **Rationale**: Gives users the app's text (FR-014, FR-024) without leaking internals.

## R10. Audit

- **Decision**: Write one event per call through `getAuditBackend().write()` (`ui/src/lib/audit/backend.ts`) with app id, action id, conversation id, outcome. No text.
- **Event type**: `auth`. The audit service drops other types at lower verbosity levels (`audit_service/verbosity.py`), which would break the "every call is recorded" criterion. A dedicated type needs an audit-service change and is left as a follow-up.
- **Rationale**: That backend is fire-and-forget and never throws. Existing event field conventions are copied from `ui/src/lib/rbac/audit.ts` during tasks.

## R11. UI placement

- **Decision**: Add a `messageActions` prop to `DynamicAgentChatPanel` next to `feedbackPrompt`. Render a new `MessageActionButtons` beside `FeedbackButton` in the per-message row (around line 3786). The row is already gated for finished assistant messages.
- **Rationale**: Smallest change. Dialog and toast use the repo's shared UI components.
- **Gating inputs**: host passes only the actions that are both declared and enabled, and only when the conversation's agent belongs to the app. Webex never reaches this panel.

## R12. Versioning

- **Decision**: Bump `CHECKER_VERSION` in `contract-version.mjs` and `version` in `app-sdk/package.json`. Leave `CONTRACT_VERSION` (`"2.0"`) unchanged.
- **Rationale**: The change is additive. The assistant option `version` stays `"1.0"`. An older host rejects the unknown key, which the docs state.
