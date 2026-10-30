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
