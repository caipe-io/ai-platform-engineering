# Agentic Apps

## Assistant connection guidance

- Admin → Platform configuration → Defaults → Assistant connection guidance: choose an installed assistant app, add up to five channel guides, preview, and explicitly save.
- Each guide has an enabled flag, accessible icon label, popup title, Markdown instructions, and an optional action label/URL. Use the exact deployment-owned bot address in the text; no bot identity is hardcoded.
- Disabled/absent guides are hidden. The assistant reloads guidance when reopened. Chat and History appear in the assistant header.
- Click a channel icon to open its instructions. The popup stays open until closed with its close button or Escape. Markdown uses the existing sanitized renderer. Actions accept HTTPS URLs without credentials or local absolute paths.
- Records are stored per app in `agentic_app_connection_guidance`. Reads require app access; writes require platform configuration administration. Changing guidance does not provision a user, link an identity, or grant agent access.
