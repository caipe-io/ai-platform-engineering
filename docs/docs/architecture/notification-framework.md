# Notification framework

CAIPE 1.4.0 adds event and preference contracts for the existing inbox.

## Event and preference contracts

- A typed platform event catalog defines categories, severity and defaults.
- Resolution uses event override, category override, then catalog default.
- A `null` patch removes an override; unknown keys and non-boolean values are rejected.
- These contracts define preference resolution. Delivery through additional
  destinations is tracked in the [Notification Framework proposal](https://github.com/caipe-io/ai-platform-engineering/issues/2934).

## Solution architecture

![The platform catalog supplies defaults. Preference resolution checks the user's event override, then their category override, then the catalog default.](/diagrams/notification-preferences.svg)

[Download editable Excalidraw](/diagrams/notification-preferences.excalidraw)

## Authenticated preference persistence

- `GET/PATCH /api/settings/notification-preferences` addresses the signed-in user only.
- Revision guards preserve concurrent edits, including first-document creation; persistent conflicts return 409.
- Existing settings remain intact and missing notification preferences use catalog defaults.

## Envelope and channel contracts

- Validate versioned metadata envelopes, bounded text, stable retry keys, and same-host relative destinations.
- Query strings and fragments are preserved. Conflicting `callbackUri` and legacy `href` values are rejected.
- Channel identifiers are contracts only; external delivery remains off until an adapter is installed and explicitly enabled.

## App registration and subscriptions

- Installed apps register 1–30 stable event types using their bound service account and `host.notifications` capability. Registration does not subscribe users.
- Users can subscribe, pause, select events/channels, and set quiet hours. App subscriptions and all external channels default off.
- Channel availability and enablement go through an adapter registry; missing integrations are unavailable.
- The host checks current app launch access. Resource-specific authorization remains the publisher responsibility pending resource-level CAS integration.

## Durable inbox queue

- Accepted jobs are durable before acknowledgement. Per-channel deliveries use deterministic keys, expiring leases, capped retries and expiry.
- Recheck current subscriptions and app launch access before delivery. Existing inbox entries remain readable.
- Only in-app delivery is implemented here; missing external adapters fail explicitly.
- `NOTIFICATION_EVENTS_ENABLED=false` stops workers and new queue acceptance. No NATS service is required.

## Trusted platform publishing

- Trusted backend producers use `POST /api/internal/notifications/events` with the configured internal publisher token. Keep this endpoint blocked at public ingress.
- Recipient subject/email must resolve to one canonical user record; mismatches are rejected.
- Direct publishing persists delivery jobs and reports failures explicitly. Publication failure must not fail the originating task.
- `NOTIFICATIONS_INTERNAL_TOKEN` enables the internal endpoint; producers are added separately.
- Selecting `NOTIFICATIONS_TRANSPORT=jetstream` before its optional implementation is installed fails publication explicitly; it never falls back to direct delivery.
