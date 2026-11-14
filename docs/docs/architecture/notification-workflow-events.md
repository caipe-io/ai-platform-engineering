# Workflow Events

- Workflow lifecycle events use the notification framework and per-event preferences.
- Repeated interruptions use distinct attempt identities, while retries of the same notification deduplicate.
- Workflow execution is not blocked by delivery errors. A pre-publication process crash remains outside the delivery queue guarantee.
