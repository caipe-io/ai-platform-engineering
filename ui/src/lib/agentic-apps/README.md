# Agentic Apps

## Assistant connection guidance

- Admin → Platform configuration → Defaults → Assistant connection guidance: choose an installed assistant app, add up to five channel guides, preview, and explicitly save.
- Each guide has an enabled flag, button label, optional Webex logo, popup title, Markdown instructions, and an optional action label/URL. Without a logo, the button displays its label. Use the exact deployment-owned bot address in the text; no bot identity is hardcoded.
- Disabled/absent guides are hidden. The assistant reloads guidance when reopened. Chat and History appear in the assistant header.
- Click the guide button or logo to open its instructions. The popup stays open until closed with its close button or Escape. Markdown uses the existing sanitized renderer. Actions accept HTTPS URLs without credentials or local absolute paths.
- Records are stored per app in `agentic_app_connection_guidance`. Reads require app access; writes require platform configuration administration. Changing guidance does not provision a user, link an identity, or grant agent access.

Connection guidance administration uses `?editor=true` for reads under both the
admin UI and system-config gates, independent of launch-role restrictions.
Guidance GET/PUT exchanges a nullable `revision`; saves reject stale revisions
with 409 and the editor offers an explicit reload without overwriting an edit.
Published guidance omits the local Webex identity-link action when linking is
not configured. The editor retains it so operators can prepare configuration.
Load failures offer Retry, and opening instructions moves keyboard focus into
the panel; Escape and Close restore the trigger focus.
