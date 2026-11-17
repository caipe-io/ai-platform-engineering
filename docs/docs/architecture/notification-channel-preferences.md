# Unsubscribe from a notification channel

- Open **Settings → Notifications → Delivery**.
- Select **Unsubscribe from all** next to the channel, then confirm.
- The global preference stops that channel across app and platform event subscriptions, including explicit per-event opt-ins.
- Other channels, followed resources, event choices, and history are preserved.
- The channel can be disabled even when its provider is unavailable. Re-enabling requires the channel to be available and configured.
- Re-enable the channel to use the saved source/event choices again. Skipped deliveries are not replayed; delivery already in progress may finish.
- Browser permission and device registrations are preserved. Disabling Web Push stops server delivery, rather than revoking the browser permission.
- Approval-workflow inbox items remain governed by the approval workflow; channel preferences do not change approval authorization.

The controls use the existing authenticated subscriptions API and global channel gate. No bulk rewriting of app/event subscriptions or new endpoint is needed.
