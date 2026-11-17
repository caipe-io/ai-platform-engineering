# Jetstream

- Set `NOTIFICATIONS_TRANSPORT=jetstream` to use the durable `CAIPE_NOTIFICATIONS` stream. Direct MongoDB remains the default.
- Explicit JetStream failures return failed publication and do not fall back silently.
- Configure broker authentication and persistent storage; no browser connects to NATS.
- Integration tests require `NATS_INTEGRATION_URL` and a disposable JetStream server.
