# Browser Push

- Browser Web Push uses VAPID, owned device subscriptions and an allowlist of trusted HTTPS push services. Devices expire after 30 days without renewal.
- Requires the public/private/subject VAPID settings and explicit user opt-in. Permission is requested only from a user action.
- Closed-tab delivery is handled by a service worker. Display receipts are best effort, distinct from provider acceptance or human reading.
- OS notification permission must also allow the browser. Test closed-tab delivery after deployment.
