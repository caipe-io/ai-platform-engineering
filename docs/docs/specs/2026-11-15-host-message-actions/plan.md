# Implementation Plan: App-Declared Message Actions in the Host Assistant

**Branch**: `2026-11-15-host-message-actions` | **Date**: 2026-11-15 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `docs/docs/specs/2026-11-15-host-message-actions/spec.md`

## Summary

- Apps declare up to 4 per-message actions in `ui.assistant.hostOptions.messageActions`.
- The host renders enabled actions on finished assistant messages in its popup.
- A new BFF route resolves the action from the installed manifest, re-checks the caller, and proxies one JSON call to the app as the user.
- Additive change to the app SDK: new capability `messageActions.v1`, new per-user `messageActions` visibility in `AssistantConfiguration`.
- No new storage. The route reads existing stored messages only.

## Technical Context

**Language/Version**: TypeScript (Next.js App Router, React); SDK is plain `.mjs` with `.d.mts` types
**Primary Dependencies**: existing only: Next.js, React, shared UI primitives (`ui/src/components/ui/`), existing `proxyAgenticAppRequest`, audit backend. No new packages.
**Storage**: N/A. Reads `messages` (`message_id`, `role`, `metadata.turn_id`). Visibility state is in-memory.
**Testing**: Jest and React Testing Library beside code (`__tests__`); SDK checks via the existing checker
**Target Platform**: Web UI (Webex clients excluded)
**Project Type**: web application (UI plus BFF in `ui/`)
**Performance Goals**: result or error shown within 35 s; no added cost to messages with no actions
**Constraints**: call timeout about 30 s; bounded request body; JSON only; no redirects; no new credential in the browser
**Scale/Scope**: at most 4 actions per app; text field up to 60,000 characters

## Constitution Check

*GATE: Passed before research. Re-checked after design: still passed.*

| Principle | Status | Note |
|---|---|---|
| I. Worse is Better / II. YAGNI | Pass | One field type, one endpoint shape, 4-action cap. No generic UI schema. |
| III. Rule of Three | Pass | Reuses existing validation helpers and proxy. No new abstraction. |
| IV. Composition | Pass | Actions passed to the panel as a prop, next to `feedbackPrompt`. |
| V. Specs as Source of Truth | Pass | Spec, plan, contracts here. |
| VI. CI Gates | Pass | `npm run lint`, `npm run build`, Jest. |
| VII. Security by Default | Pass | Manifest-only declarations, server re-checks, text never logged. See contracts. |

No violations. Complexity Tracking not needed.

## Project Structure

### Documentation (this feature)

```text
docs/docs/specs/2026-11-15-host-message-actions/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   ├── manifest-message-actions.md
│   ├── bff-assistant-actions.md
│   ├── app-endpoint.md
│   └── sdk-capability-and-configuration.md
├── checklists/requirements.md
└── tasks.md            # created by /speckit.tasks
```

### Source Code (repository root)

```text
ui/
├── app-sdk/
│   ├── assistant-options.mjs            # validate messageActions, extension id, configuration
│   ├── assistant-options.d.mts          # types
│   ├── iframe-bridge.mjs                # configureAssistant carries messageActions
│   ├── index.d.ts                       # re-export types
│   ├── contract-version.mjs             # bump CHECKER_VERSION
│   ├── package.json                     # bump version
│   └── README.md                        # manifest example, contract
├── src/
│   ├── lib/agentic-apps/
│   │   ├── assistant-actions.ts         # NEW: resolve action from manifest; proxy call
│   │   └── assistant-presentation.ts    # never persist messageActions (enablement is per mount)
│   ├── app/api/v1/chat/assistant-actions/
│   │   └── route.ts                     # NEW: POST route
│   ├── components/
│   │   ├── chat/DynamicAgentChatPanel.tsx          # messageActions prop; row render
│   │   ├── chat/MessageActionButtons.tsx           # NEW: buttons, dialog, states
│   │   ├── agentic-apps/AgenticAppAssistantOverlay.tsx  # pass declared and enabled actions
│   │   └── agentic-apps/AgenticAppShell.tsx             # iframe capability and configure
│   └── native-extensions/host-chat.tsx  # extensions list and configure validation
└── (tests beside each, plus app-sdk checks)
docs/docs/ui/                            # developer docs section (path confirmed during tasks)
```

**Structure Decision**: Extend the existing UI and BFF in `ui/`. Reuse `proxyAgenticAppRequest`, `authenticateChatStreamRequest`, `authorizeConversationWriteAccess` and `requireAgentUsePermission`. The only new modules are one lib file, one route and one component.

## Database migrations

N/A. No `db-migration.md`. The feature adds no collection, field or index.
