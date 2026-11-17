# Notification collector exports

- Optional operator-owned Splunk HEC and OTLP/HTTP JSON logs sinks export allowlisted event metadata only: no text, recipients, destinations or credentials.
- Each sink queues once per logical event, independently of personal subscriptions. Separate retry records preserve isolation and honor Retry-After; permanent/partial rejections are not blindly retried.
- Both sinks default off. Configure `NOTIFICATION_SPLUNK_ENABLED` / `NOTIFICATION_OTEL_ENABLED`, approved endpoints and existing Secrets. HTTPS is required unless private HTTP is explicitly allowed.
- Actual local HTTP mock-collector contracts are covered by tests. This extraction does not establish connectivity to a live operator collector.
