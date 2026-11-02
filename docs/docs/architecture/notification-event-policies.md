# Notification event management

- Personal settings control subscriptions, pauses and delivery choices. They never grant event access.
- Organization admins manage registered events at **Admin → Platform configuration → Notification events**.
- Platform event IDs and publishers are defined in code. Operators edit labels, defaults, enablement and permitted channels.
- Service health events retain an organization-admin audience. Operators cannot broaden it.
- Approval requests retain their existing workflow's organization-admin and explicitly configured reviewer audience. The approval inbox cannot be disabled or published through the generic notification API. Approval actions still require their existing authorization checks.
- Operators can add app event types only for installed, enabled apps with `host.notifications` and a bound publisher service account. This does not install a publisher or implement an event trigger.
- Operator event declarations and policy overrides are stored separately from app-owned declarations. App re-registration cannot overwrite them.
- App subscriptions and external delivery remain opt-in. A policy cannot subscribe users or configure arbitrary external destinations.
- Audience restrictions apply at queue acceptance, delivery, inbox reads and callback resolution. Resource-specific project/document authorization is still a separate production requirement.
- Changes use revision checks and the platform audit backend. Concurrent editors must reload on HTTP 409.
