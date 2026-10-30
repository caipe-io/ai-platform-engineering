# Autonomous Agents Events

- Lifecycle producers send bounded metadata through the configured internal notification endpoint.
- Missing endpoint/token disables publication. Delivery failure does not fail the run.
- Set `NOTIFICATIONS_INTERNAL_URL`, `NOTIFICATIONS_INTERNAL_TOKEN` and `NOTIFICATION_EVENTS_ENABLED`; dynamic chat also supports `NOTIFICATION_CHAT_MIN_SECONDS`.
- A pre-publication process crash remains outside the delivery queue guarantee.
