---
sidebar_position: 3
---

# Settings and Admin

CAIPE separates configuration from platform operations:

- **Settings** is a routed workspace. It contains personal preferences and a
  safe, signed-in-user view of shared system health.
- **Admin** is a routed workspace for managing people, resources,
  integrations, operations, and security policy.

Open Settings from **Profile picture → Settings**. The Appearance shortcut in
the application header opens the same workspace directly at Appearance.

## Settings map

### Personal

- **Appearance** — theme, typography, and accent gradient.
- **Chat & agents** — per-surface default agents and conversation behavior.
- **Notifications** — personal release-note notifications.
- **System health** — shared capability status and running build information.
- **Account & access** — your identity, platform role, and teams.
- **Developer** — debug preferences and session diagnostics.

System Health deliberately omits probe targets and operational remediation.
Admins can open **Admin → Operations → Health** for those details.

The sidebar footer is a compact health entry point:

- Its dot uses the aggregate platform status: green for healthy, amber for
  degraded, red for down, and muted while checking.
- The footer version and dot both link to **Settings → System health**.
- System Health shows the UI build and a release version for every listed
  capability. `PLATFORM_COMPONENT_VERSION_<COMPONENT_ID>` overrides a specific
  component; `CAIPE_RELEASE_VERSION` supplies the shared deployment fallback.
- Docker Compose sets `CAIPE_RELEASE_VERSION` from `IMAGE_TAG` by default;
  Helm uses the CAIPE UI image tag.

## Platform health notifications

Health messages and personal notifications share the durable
`in_app_notifications` collection but remain distinct:

- User and team messages keep their existing audiences.
- Health messages use the global signed-in-user audience and carry a visible
  **Platform** label.
- Each user can hide or restore Platform messages from **Settings →
  Notifications**. This changes only that user's feed and unread count; it
  does not alter the global incident or another user's feed.
- Read state is per viewer; resolving a health incident is global.
- Two consecutive failing audits open an incident by default. Two consecutive
  healthy audits resolve it automatically.
- An authorized admin can resolve an active notification after human review.
  A continuing failure can reopen it after audit confirmation.

The audit lease and per-component incident state are stored in MongoDB so
multiple BFF replicas do not create duplicate messages. Thresholds can be
adjusted with `PLATFORM_HEALTH_NOTIFICATION_FAILURE_THRESHOLD`,
`PLATFORM_HEALTH_NOTIFICATION_RECOVERY_THRESHOLD`, and
`PLATFORM_HEALTH_NOTIFICATION_AUDIT_INTERVAL_MS`.

AI Review and access-before-sign-in policy remain in **Admin → Security &
Policy** because they are governance and access-management workflows.

## Admin map

Admin opens at **Teams & Users → Users**. Its category buttons disclose their
destinations without navigating, allowing an administrator to choose the exact
page before leaving the current one.

- **Resources** — agent configuration, Skill Hubs, service accounts, and
  credential administration.
- **Teams & Users** — users, teams, and identity sync.
- **Integrations** — Slack and Webex administration.
- **Insights** — statistics and feedback.
- **Metrics & Health** — operational metrics, health, and authorization
  insights.
- **Security & Policy** — access policy, AI Review, authorization tools,
  audits, identity health, and migrations.

## Saving changes

Single-setting controls save when you interact with them:

- The control updates immediately.
- An inline status reports **Saving**, **Saved**, or an actionable error.
- Failed server-authoritative changes roll back and can be retried.
- Web, Slack, and Webex default-agent choices save independently.

Multi-field policy and access forms retain an explicit review/apply action.

## Platform default agent

The platform default applies only when a person has not chosen a personal
default. Choosing one makes that agent available to every signed-in user, so
CAIPE explains the consequence and asks for confirmation before persisting it.

Resolution order:

1. A person's default for the current surface.
2. The persisted platform default.
3. The `DEFAULT_AGENT_ID` deployment fallback.
4. No default agent; the user chooses an accessible agent.

If the configured agent is missing or no longer visible, Settings shows a
warning. Choose another agent or remove the platform default.

## Access control

- Any signed-in user can manage personal preferences and inspect their own
  account and access information.
- Only admins can see or change Platform settings.
- Admin View as remains read-only for operational and policy controls.
- Sensitive session and token values remain concealed until explicitly opened.

## Related pages

- [UI customization and branding](../ui/customization.md)
- [Agent Builder](./agent-builder.md)
- [RBAC architecture](../security/rbac/architecture.md)
