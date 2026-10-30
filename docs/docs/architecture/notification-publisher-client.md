# Publisher Client

- Shared Python helper publishes bounded lifecycle metadata to the internal notification endpoint.
- Configure `NOTIFICATIONS_INTERNAL_URL` and `NOTIFICATIONS_INTERNAL_TOKEN`; missing configuration disables publishing.
- Uses bounded timeouts and never exposes tokens or causes the producer job to fail on notification errors.
- Separately packaged services vendor the same small helper so their images do not acquire the platform dependency tree.
