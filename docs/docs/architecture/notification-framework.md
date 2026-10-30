# Notification framework

Small implementation units extend the existing inbox.

## Event and preference contracts

- A typed platform event catalog defines categories, severity and defaults.
- Resolution uses event override, category override, then catalog default.
- A `null` patch removes an override; unknown keys and non-boolean values are rejected.
- This unit starts no workers, publishes no events, and changes no delivery behavior.

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
