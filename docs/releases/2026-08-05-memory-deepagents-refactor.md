# Memory storage and Projects

Dynamic Agent memory now uses deepagents Markdown memory files in a dedicated,
non-expiring GridFS bucket. Memory ownership moves from email to the immutable
Keycloak subject, and conversations may carry an immutable `project_id`.

Breaking surface changes:

- `memory_context_used` is no longer emitted; persisted events are rendered as
  `memory_injected` by the UI.
- The five memory tools (`remember`, `recall_memory`, `list_memories`,
  `update_memory`, and `forget_memory`) are removed. Agents use `read_file`,
  `edit_file`, and `grep` on mounted memory paths.
- Memory `category` and record `enabled`/disable behavior are removed. Delete is
  the only removal operation.
- Memory titles are unique within a file. Normalized-title collisions are
  rejected rather than silently merged, and structured edits target one hidden
  record ID while preserving its provenance.
- Raw `AGENTS.md` is read-only in Manage Memory and through the memory API.
  Users edit records through Add, Edit, and Delete; Source supports Copy and
  Download only.
- Administrators may enable named Projects platform-wide in Platform Settings
  or with `PROJECTS_ENABLED`. Every agent can then use the Project picker,
  shared workspace, and on-demand Project history; memory-enabled agents also
  receive Project memory. `builtin_tools.create_project.enabled` only grants an
  agent permission to create Projects from chat.
- `interrupt_on: {builtin: {remember: ...}}` no longer applies. deepagents 0.6.4
  gates by tool name and cannot express approval for writes to only memory
  paths.
