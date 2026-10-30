# Agent Requested Alerts

- `POST /api/notifications/agent-events` accepts only a signed-in user and a saved chat they own. Shared/admin-audit access and service accounts are rejected.
- Event types: `input_required`, `completed`, `failed`. Recipient, content, callback, channels and destinations are host-controlled.
- Stable caller event IDs deduplicate retries; quota and subscription checks apply. An alert does not pause, resume or approve agent execution.
- Platform MCP transport/tool exposure remains in #2866 and requires explicit assignment to agents.
