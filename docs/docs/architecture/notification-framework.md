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
