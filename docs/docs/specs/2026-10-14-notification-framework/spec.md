# Notification Framework (Phase 1 slice)

Tracks: epic caipe-io/ai-platform-engineering#2934. Architecture target: discussion #2937.

## Problem

- Ingestion, workflow, and autonomous task completion and failure produce no notification.
- Agent completion alerts are browser-only and never stored.
- Users cannot choose which events notify them.

## Scope

- In: typed event catalog, envelope validation, preference resolution, direct (in-process) transport, consumer that writes the existing inbox, and UI-server producers for workflow terminal states.
- Out: NATS transport, JetStream, Python producers, shared team or org routes, runtime admin, App Contract bindings, extra delivery channels.

## Requirements

- Preferences resolve in this order: explicit event setting, explicit category setting, catalog default.
- Defaults: completion, failure, and requires-input events are on. Started and progress events are off.
- Preference writes accept only known keys with boolean values. Unknown keys are rejected.
- Repeating the same preference write yields the same stored state.
- Each event produces at most one inbox entry. Duplicate deliveries are ignored by a deterministic `event_key`.
- Producers never receive audience data from clients. Recipients are set server-side only.
- Publishing never throws into the producing job or workflow.
- Event payloads carry status and a short summary only. No prompts, documents, tool output, or secrets.

## Acceptance

- Unit tests cover: default and override resolution, invalid and unknown input rejection, envelope validation, dedupe on redelivery, and publish errors that are swallowed.
- `npm run lint`, `npm run build`, and `npm test` pass in `ui/`.
- With the feature disabled, workflow behavior is unchanged.

## Open

- Identifier for preferences: the inbox uses subjects, while `user_settings` keys by email. Decide before the workflow producer ships.
- Recipient rule for ingestion jobs with no owner (Python producers, a later increment).
