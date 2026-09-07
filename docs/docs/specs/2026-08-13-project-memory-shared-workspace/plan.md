# Implementation Plan: Projects, Project Memory, Shared Files, and Project Chat History

**Status**: Implemented
**Date**: 2026-08-13
**Supersedes**: The dynamic `namespace_source` and `namespace_scoped_tools` design in the
2026-08-05 memory refactor plan. The global, agent, structured-record, read-only-source, and
DeepAgents middleware portions of that plan remain.

## Outcome

Add a first-class **Project** working context without coupling projects to MCP servers or external
database records.

A project provides:

- one user-owned project identity;
- one project memory file shared across memory-enabled agents;
- one filesystem shared by chats using the same agent and project;
- on-demand access to the user's past chats in that project;
- an optional project picker when starting a conversation.

The user-facing concept is always **Project**. Do not expose `namespace`, `key_path`, `label_path`,
`bind_arg`, static contexts, dynamic contexts, or custom namespaces in the UI.

## Locked decisions

| Area | Decision |
|---|---|
| Project identity | The user or agent supplies a name; CAIPE derives the ID from the name |
| Example | `Project A` becomes `project_a` |
| Mutability | Project name and ID cannot be changed |
| Duplicate handling | Reject creation when the normalized ID already exists |
| Project types | None; no hidden pod/repository/project subtype |
| MCP relationship | None in storage; the agent reasons about matching names when an MCP is relevant |
| Project catalog | The existence and metadata of `/memories/projects/<id>/AGENTS.md` are authoritative |
| Unscoped access | May list project metadata and create projects; may not read or write project memory/files/history |
| Scoped access | May access only the selected project's memory, project filesystem, and project chats |
| Project selection | Optional and immutable for the lifetime of a conversation |
| Project availability | One platform-wide administrator setting; not an agent capability |
| Project memory | Shared across the user's memory-enabled agents |
| Project filesystem | Shared across chats only when both `agent_id` and `project_id` match |
| Past chats | Read on demand; never inject every project transcript automatically |
| Project creation | Users create from the sidebar; `create_project` is an optional per-agent tool |
| Project deletion | Deferred; memory records remain individually deletable |
| Project rename | Not supported |

## Mental model

```text
User
├── Global memory
│   └── available to every memory-enabled agent chat
├── Agent memory
│   └── available to every chat with that agent
└── Projects
    └── Project A (project_a)
        ├── project memory
        │   └── shared across memory-enabled agents
        ├── project chat history
        │   └── searchable across the user's Project A chats
        └── per-agent project filesystem
            ├── Agent 1 files shared across Agent 1 + Project A chats
            └── Agent 2 files shared across Agent 2 + Project A chats
```

Projects organize context. They do not become copies of structured data owned by an MCP.

```text
MCP / database                          CAIPE Project
---------------------------             -----------------------------
structured current data                 ambiguous learned context
status, members, timestamps             user preferences and conventions
pod/repository-specific fields          shared files produced in chats
authoritative operational record        links to related project chats
```

## Platform and agent configuration

Projects are enabled or disabled for the whole deployment. The persisted Admin
setting overrides the environment default:

```yaml
PROJECTS_ENABLED: "true"
```

Rules:

- Projects disabled means global and agent memory still work, but:
  - no project picker;
  - no project tools;
  - no project can be attached to a new conversation.
- Projects enabled adds project listing, user-side creation, selection, files,
  and chat-history access for every agent. Agents with Memory enabled also
  receive the selected Project memory.
- `builtin_tools.create_project.enabled` grants only the model's `create_project`
  tool. It cannot enable Projects or grant other Project access.
- Remove these fields from the active configuration model and Agent Builder:
  - `namespace_source`;
  - `namespace_scoped_tools`;
  - `key_path`;
  - `label_path`;
  - `bind_arg`;
  - `require_namespace`;
  - static namespace lists;
  - `allow_custom`.

Agent Builder exposes one independent built-in tool capability:

```text
[ ] Create Project
    Lets this agent create a Project from chat. Project availability and
    selection are controlled platform-wide.
```

No MCP server is automatically enabled, locked, or mapped by this option.

## Project identity

Each project has exactly two public identity fields:

```json
{
  "id": "project_a",
  "name": "Project A"
}
```

The project creator supplies only `name`. The server derives `id`.

### Normalization

Normalize once at creation:

1. Trim leading and trailing whitespace.
2. Collapse repeated internal whitespace to one space for the stored name.
3. Lowercase for the ID.
4. Convert spaces to `_`.
5. Collapse repeated `_` characters.
6. Permit only lowercase ASCII letters, digits, `_`, and `-` in the ID.
7. Require 1-64 ID characters.
8. Reject an ID matching the UUID shape used by conversation IDs, preventing the two exact
   filesystem namespace forms from colliding.

Examples:

| Input name | Stored name | Generated ID |
|---|---|---|
| `Project A` | `Project A` | `project_a` |
| ` project   a ` | `project a` | `project_a` |
| `PROJECT_A` | `PROJECT_A` | `project_a` |

`Project A`, `project a`, and `PROJECT_A` therefore collide and the second creation returns
`409 project_already_exists`.

Unsupported punctuation is rejected with a clear validation error. Do not silently remove it and
produce a surprising ID.

### Immutability

- There is no rename endpoint.
- Neither the name nor ID can be patched through conversation or memory APIs.
- A future rename feature requires a separate design because it must move memory and all
  `(agent_id, project_id, "filesystem")` namespaces.

## Project catalog and storage

Do not add a second project metadata collection. The project memory file is the authoritative
project record and guarantees that every listed project already has a memory location.

Path:

```text
/memories/projects/project_a/AGENTS.md
```

Initial contents:

```markdown
<!-- caipe-memory:file v=1 scope=project project_id=project_a project_name=Project%20A -->
_No memories saved here yet._
```

The existing memory codec already preserves extra file-marker metadata. Extend it so project
metadata is validated and restored after agent edits rather than trusting edited marker fields.

`list_projects` scans only canonical project memory paths in the authenticated user's memory
store and returns the immutable marker metadata:

```json
[
  {"id": "project_a", "name": "Project A"},
  {"id": "project_b", "name": "Project B"}
]
```

It never returns memory records or raw `AGENTS.md` contents.

### Project creation

`create_project(name)` performs a create-only operation:

```text
validate name
→ generate project_id
→ atomically reject an existing user/project path
→ write the canonical header and placeholder
→ return id, name, and a Start project chat action
```

It is deliberately not an upsert:

- existing normalized ID: `409 project_already_exists`;
- existing memory is never overwritten;
- retries do not reset the project file;
- two concurrent attempts produce one project and one duplicate response.

Add a unique compound index for the memory bucket's `(metadata.namespace, metadata.key)` identity
and a create-if-absent store operation. Existing ordinary memory updates continue using their
etag-based replace behavior.

If the project file is missing after an interrupted creation, selecting the catalog entry cannot
occur because the file itself is the catalog entry. There is no half-created metadata row.

## Memory architecture

Memory remains in the dedicated non-expiring `agent_memory` GridFS bucket under the authenticated
Keycloak `sub`:

```text
store namespace: (owner_subject, "memory")
```

### Paths and injection

| Memory scope | Path | Injected when |
|---|---|---|
| Global | `/memories/global/AGENTS.md` | Every memory-enabled chat |
| Agent | `/memories/agents/<agent_id>/AGENTS.md` | Every memory-enabled chat with that agent |
| Project | `/memories/projects/<project_id>/AGENTS.md` | Only when that project is selected |

Unscoped conversation:

```text
sources = [global, agent]
```

Project conversation:

```text
sources = [global, agent, selected project]
```

Never inject memory for every known project.

### Memory permissions

Unscoped chat:

```text
allow read+write /memories/global/AGENTS.md
allow read+write /memories/agents/<agent_id>/AGENTS.md
deny  read+write /memories/projects/**
deny  read+write /memories/**
```

Project chat:

```text
allow read+write /memories/global/AGENTS.md
allow read+write /memories/agents/<agent_id>/AGENTS.md
allow read+write /memories/projects/<selected_project_id>/AGENTS.md
deny  read+write /memories/projects/**
deny  read+write /memories/**
```

Specific allow rules precede the final deny rule because DeepAgents uses first-match filesystem
permissions.

The project catalog tools operate outside the model-visible filesystem permission surface. An
unscoped chat can see `{id, name}` but cannot use `read_file`, `grep`, `glob`, `edit_file`, or
`write_file` against any project memory.

Subagents retain the existing explicit `/memories/**` deny unless a later design intentionally
grants project memory to them.

### Structured records and source view

Keep the existing memory record behavior:

- Memories tab: Add, Edit, and Delete individual titled records.
- Source tab: read-only raw `AGENTS.md`, with Copy and Download.
- No raw source editing.
- Titles are unique after normalization within one memory file.
- Record IDs remain stable.
- Empty/cleared project memory retains the immutable project header and placeholder.
- Clearing project memory must not delete the project itself.
- Project file deletion is rejected until an explicit project-delete feature exists.

The memory dialog labels the scopes as:

```text
Global
Agent: <agent name>
Project: <project name>
```

The `memory_injected` and `memory_update` events continue to identify structured memory record IDs,
so the existing injected-memory badges and modal deep-links remain usable.

### Chat memory toggle

The selected project is conversation metadata, independent of the per-turn `memory_enabled`
toggle:

- `project_id` still determines the shared filesystem and project chat list;
- `memory_enabled: false` suppresses global, agent, and project memory injection and writes for
  that turn;
- toggling memory does not change the selected project.

## Conversation model

Add an immutable project field:

```json
{
  "metadata": {
    "project_id": "project_a"
  }
}
```

Rules:

- `project_id` is optional at conversation creation.
- The BFF validates it against `list_projects` for the authenticated owner.
- The platform-wide Projects setting must be enabled.
- The stored value is authoritative after creation.
- Chat stream/resume requests must match the stored value.
- Conversation update APIs reject adding, removing, or changing it.
- Switching projects always starts a new conversation.
- A project chat starts with no copied transcript from another chat.

Add a typed `project_id: string | null` field to chat, resume, scheduler, and UI conversation models.
Do not hide it in opaque `client_context`.

## New-chat flow

When Projects are disabled platform-wide:

```text
New chat
→ no project control
→ conversation-scoped filesystem
```

When Projects are enabled platform-wide, for every agent:

```text
New chat
→ optional project picker
   ├── No project
   ├── Project A
   └── Project B
→ create conversation with immutable project_id or null
```

Picker requirements:

- collapsed/compact until used;
- `No project` remains valid;
- show project name, not the normalized ID as the primary label;
- show a retryable error if the catalog is unavailable;
- never block an unscoped chat because project listing failed;
- do not allow free-form project IDs in the picker.

## Unscoped chat behavior

An unscoped chat receives these project tools only when the agent has Projects enabled:

```text
list_projects()
create_project(name)
```

It does not receive:

- project memory contents;
- project filesystem access;
- project chat-history tools.

The system instruction says:

```text
- You may list the user's project names and create a named project.
- Before creating a project, list existing projects and compare their names.
- If create_project reports a duplicate, use the existing project.
- Project contents are not accessible in this chat.
- After creating or finding the relevant project, ask the user to start a new
  chat with that project selected.
```

The model is allowed to reason about spelling and semantic similarity. The backend only enforces
the exact normalized-ID duplicate rule.

### Creating projects after MCP work

There is no MCP mapping, interception layer, hidden project type, or automatic `ensure_project`.

For a domain agent, its ordinary instructions may say:

```text
When you create a new named long-lived work item with the configured MCP tools,
list the user's projects. If the intended project does not exist, create a project
with the same display name, then offer to start a project chat.
```

For example, a pod-oriented agent can be explicitly instructed to create a same-named project
after a successful pod creation. The model performs the name comparison.

`create_project` returns structured action metadata so the UI can render:

```text
[Start chat in Project A]
```

Clicking it creates a new conversation with `project_id=project_a`. The current conversation is not
mutated.

## Project chat behavior

At graph construction, inject explicit context:

```text
Active project: Project A
Project ID: project_a

This conversation is permanently scoped to this project. You may use the mounted
project memory, shared filesystem, and project chat-history tools. Do not access or
claim access to any other project.
```

Do not globally instruct every project chat to call `get_pod` or any other MCP tool. Projects are
untyped. The prompt instead says:

```text
When structured external data appears relevant, use your available tools to find a
record matching the active project name. Do not assume that every project belongs to
a particular MCP server.
```

A pod-specific agent can add a stronger domain instruction:

```text
At the start of a project chat, list pods. If one matches the active project name,
load it with get_pod before working on pod-specific tasks. If no pod matches, continue
without pretending that one exists.
```

This keeps the generic Projects implementation independent of MCP schemas.

## Shared filesystem

Use exactly one of two 3-component namespaces.

Unscoped conversation:

```text
(agent_id, conversation_id, "filesystem")
```

Project conversation:

```text
(agent_id, project_id, "filesystem")
```

Resolution:

```python
if explicit_workflow_fs_namespace:
    fs_namespace = explicit_workflow_fs_namespace
elif project_id:
    fs_namespace = (agent_id, project_id, "filesystem")
else:
    fs_namespace = (agent_id, conversation_id, "filesystem")
```

Consequences are intentional:

- two chats with the same agent and project share every filesystem file;
- two different agents in the same project do not share filesystem files;
- unscoped chats remain isolated;
- filenames and directory structure are unchanged;
- deleting a file in one project chat deletes it for the other chats using that agent/project;
- temporary tool-result files and generated artifacts are also shared because the whole
  filesystem namespace is shared;
- skills continue to be cleared/reseeded per runtime inside this namespace, which is safe because
  the namespace already includes `agent_id`.

### Persistence

Project filesystem writes must be durable:

```text
project filesystem ttl_seconds = 0
conversation filesystem ttl_seconds = existing configured/default value
```

The existing `agent_files` TTL index only deletes documents carrying `metadata.expireAt`, so
project writes omit that field while unscoped files keep current TTL behavior.

### File endpoint resolution

Clients must not decide the namespace by constructing an array themselves.

For conversation file APIs:

```text
conversation_id
→ load owned conversation
→ verify agent participant
→ read immutable metadata.project_id
→ derive one of the two namespace tuples
→ list/read/write/delete files
```

Update these consumers to use the same resolver:

- runtime backend construction;
- UI file list/download/delete calls;
- file-count aggregation;
- audit file views;
- conversation clear operations;
- workflow/scheduled-run file calls where applicable.

Current file ownership logic assumes namespace component 2 is a conversation ID. Replace that
assumption for conversation-facing routes: authorize using the supplied conversation record, then
derive the namespace server-side.

### Clear and deletion behavior

- Clearing checkpoints for one project chat must not delete the shared project filesystem.
- Permanently deleting one project chat must not delete the shared project filesystem.
- Clearing/deleting an unscoped chat may delete its conversation filesystem as today.
- Project filesystem deletion is deferred with project deletion.

## Past project chats

Messages already live in MongoDB separately from LangGraph checkpoints:

```text
conversations.metadata.project_id = project_a
messages.conversation_id = <conversation UUID>
```

Add project-scoped built-in tools:

```text
list_project_chats(limit?, cursor?)
search_project_chats(query, limit?, cursor?)
read_project_chat(conversation_id, offset?, limit?)
```

These tools are available only when a project is selected.

### Scope and validation

The runtime binds these values; the model cannot override them:

```text
owner_subject = authenticated user's immutable sub
project_id    = conversation's immutable project_id
```

Every result must satisfy both values. `read_project_chat` additionally verifies that the requested
conversation belongs to that owner and project before reading messages.

Project history is user-wide rather than agent-wide. An agent in a Project chat may inspect the
authenticated user's past chats in the selected project even when another agent produced them.
This matches the user-wide project memory model. It does not grant access to another user's chats.

### Returned data

`list_project_chats` returns metadata only:

```json
[
  {
    "conversation_id": "00000000-0000-4000-8000-000000000001",
    "title": "Prepare launch checklist",
    "agent_id": "agent-primary",
    "agent_name": "Primary Agent",
    "created_at": "2026-08-13T09:00:00Z",
    "updated_at": "2026-08-13T10:00:00Z"
  }
]
```

`search_project_chats` searches:

- conversation title;
- user message text;
- assistant message text.

`read_project_chat` returns bounded, paginated user/assistant transcript text. It excludes:

- system messages;
- hidden reasoning;
- raw trace data;
- unrelated stream-event payloads;
- file contents, which remain accessible through the shared filesystem.

Do not inject all past chats automatically. The project system prompt tells the model to use these
tools when the user refers to earlier work or when prior decisions are needed.

Add indexes:

```text
conversations(owner_subject, metadata.project_id, updated_at)
messages(conversation_id, created_at)  # already present
```

Use existing Mongo text/search capabilities appropriate to the deployment; preserve pagination and
hard response-size limits.

## UI plan

### Agent Builder

- Keep the Memory switch.
- Add the independent **Create Project** built-in tool and helper text.
- Remove the dynamic working-context editor and all MCP/path/binding fields.

### Platform settings and sidebar

- Add one administrator-controlled platform Projects setting with a deployment
  environment fallback.
- Show Project selection for every agent only while the platform setting is enabled.
- Let users create Projects from the sidebar above History.

### New chat

- Show the optional project picker for every agent when Projects are enabled platform-wide.
- Default to `No project`.
- Store `project_id` at conversation creation.
- Lock the choice after creation.

### Active chat

Show a project badge/header when scoped:

```text
Project A
```

The badge is informational; it does not open a mid-chat switcher.

Project file UI says that files are shared with other chats using the same agent and project.

### Project tool results

- `list_projects`: compact project list with Start chat actions.
- `create_project`: created state plus Start chat action.
- duplicate response: link to start a chat in the existing project.
- project-history results: link to the original chat where the user has UI access.

### Memory dialog

- Active section contains Global, current Agent, and selected Project.
- Other section contains other agent and project memory files owned by the user.
- Project rows use immutable display names from the file marker.
- Only `Memories` and read-only `Source` tabs remain.

### Chat list

At minimum:

- retain independent chat rows;
- show the project name/badge on project chats;
- allow filtering by project.

A nested ChatGPT-style project sidebar is optional follow-up UI and not required for the backend
or memory architecture.

## API surface

### Project API

Dynamic Agents service:

```text
GET  /api/v1/projects
POST /api/v1/projects        { name }
```

Responses:

```json
{
  "success": true,
  "data": {
    "items": [{"id": "project_a", "name": "Project A"}]
  }
}
```

```json
{
  "success": true,
  "data": {
    "project": {"id": "project_a", "name": "Project A"}
  }
}
```

The UI BFF exposes authenticated thin proxies under `/api/user/projects` and never accepts an owner
identifier from the request body.

No PATCH or DELETE endpoint in the first version.

### Conversation API

Add `project_id` to:

- conversation-create request metadata;
- chat stream and invoke requests;
- resume requests;
- conversation response types;
- schedules and one-off scheduled runs;
- browser streaming consumers;
- persisted conversation metadata.

Conversation creation validates the platform setting and owned project. Stream/resume validates
against the stored immutable value.

### Files API

Conversation-facing endpoints accept `conversation_id` and derive the namespace. Raw namespace
endpoints remain only for trusted workflow/internal paths that already require them.

### SSE and tool actions

Add a small project action payload for:

- project created;
- project already exists;
- start project chat.

Do not overload `memory_update`; creating an empty project creates no memory record.

## System prompts

Generate project instructions from runtime capability and active scope rather than requiring every
agent author to reproduce platform rules.

### Projects enabled, no active project

- Projects are named working contexts.
- Project metadata may be listed.
- Project contents are inaccessible.
- List before creating.
- After locating or creating a project, offer a new project chat.

### Active project

- State immutable project name and ID.
- State the exact project memory path.
- Explain that project files are shared across this agent's project chats.
- Explain that past project chats are available through project-history tools.
- Prohibit access claims about other projects.
- Tell the model to use relevant MCP tools by reasoning from the project name, without assuming a
  universal MCP type.

## Authorization and privacy

Projects are private to one immutable Keycloak subject in the first version.

- Project catalog ownership comes from the memory store namespace `(sub, "memory")`.
- Never use email as the production owner key.
- Never accept `owner_subject` from a client body.
- Selecting a project requires both:
  - ownership of the project;
  - permission to use the selected agent.
- Sharing one conversation does not share:
  - the project catalog;
  - project memory;
  - the project filesystem;
  - other project chats.
- A shared-chat recipient sees only the explicitly shared conversation under existing ReBAC rules.
- Admin audit access does not mount project memory or files into an agent run.
- Project history tools use owner/project filters before message lookup.

Team/shared projects require a separate authorization model and are out of scope.

## Concurrency and integrity

### Project creation

- Compound unique index makes normalized-ID creation race-safe.
- `create_project` is create-only.
- Duplicate creation never overwrites `AGENTS.md`.

### Project memory

- Existing etag checks protect manual record edits.
- Existing middleware reconciliation protects agent edits.
- Project marker metadata is restored from the pre-edit file.
- Existing memory size limits apply per project memory file.

### Shared filesystem

The initial shared filesystem keeps current last-write-wins behavior. Two simultaneous chats editing
the same path may overwrite one another.

This is acceptable for the first version, but must be visible in documentation. A later per-file
etag or lock can improve concurrent editing without changing the namespace model.

## Legacy namespace compatibility

This plan replaces the unreleased dynamic-namespace design:

```text
/memories/namespaces/<key>/AGENTS.md
memory_namespace
namespace_source
namespace_scoped_tools
```

with:

```text
/memories/projects/<project_id>/AGENTS.md
project_id
PROJECTS_ENABLED
list_projects / create_project
```

Preferred path while the feature is still unreleased:

- replace the namespace implementation in place;
- do not ship both configuration models;
- update tests and docs to use Projects terminology;
- no migration is required for newly created project memories.

If any deployed environment already contains namespace-scoped conversations, keep a temporary
read-only compatibility path:

- legacy conversations continue mounting their legacy namespace file;
- they retain conversation-scoped filesystems;
- new conversations cannot select legacy namespaces;
- no automatic MCP-to-project migration;
- admins/users may create a same-named Project and copy wanted memory records explicitly.

Do not silently reinterpret an arbitrary legacy namespace as a Project because no immutable display
name was stored.

## Implementation phases

### Phase 1: Project identity and memory paths

- Add platform-wide `PROJECTS_ENABLED` configuration with a persisted Admin override.
- Add project-name normalization and validation.
- Extend canonical memory paths with `/memories/projects/<id>/AGENTS.md`.
- Store immutable project ID/name in file-marker metadata.
- Add create-if-absent storage and unique identity index.
- Add project list/create APIs.
- Protect project marker metadata during codec reconciliation.

### Phase 2: Project tools and prompts

- Add platform `list_projects` and optional per-agent `create_project` tools.
- Gate Project facilities on the platform setting and creation on
  `builtin_tools.create_project.enabled`.
- Add unscoped and scoped project prompt fragments.
- Add Start project chat action metadata.

### Phase 3: Conversation selection and memory mounting

- Add immutable `project_id` to request, resume, persistence, and UI types.
- Validate the platform setting and project ownership at conversation creation.
- Mount only global + agent + selected project memory.
- Apply exact memory permissions.
- Update injected-memory labels and memory dialog project rows.

### Phase 4: Conditional shared filesystem

- Change runtime namespace resolution to the exact two-form rule.
- Use no TTL for project filesystem writes.
- Derive file namespaces from stored conversation metadata in every conversation file endpoint.
- Update UI file list/content/delete and file-count consumers.
- Prevent conversation clear/delete from deleting a shared project filesystem.

### Phase 5: Project chat history

- Add indexes for owner/project conversation lookup.
- Add list/search/read project-chat tools.
- Bind owner and active project in the runtime.
- Add pagination, content limits, and transcript filtering.
- Add UI links to returned chats.

### Phase 6: Agent Builder and UI cleanup

- Replace the dynamic-context editor with the independent **Create Project** tool.
- Remove namespace-source and tool-binding types and validation.
- Add new-chat picker, active project badge, chat filtering, and project tool-result actions.
- Add the platform Admin setting and sidebar Project creation above History.
- Update schedules to preserve the originating project selection.

### Phase 7: Documentation, compatibility, and release

- Rewrite user-memory docs around Global, Agent, and Project memory.
- Document shared-file semantics and last-write-wins behavior.
- Remove or isolate legacy namespace compatibility code.
- Add release notes for configuration and API field changes.
- Build only the images changed by implementation and update deployment tags.
- Kind-load those images for local verification.
- Do not deploy without a separate explicit request.

## Verification

### Project identity tests

- whitespace and case normalize to one ID;
- spaces become `_`;
- repeated `_` collapses;
- unsafe punctuation is rejected;
- UUID-shaped IDs are rejected;
- name and ID cannot be changed;
- concurrent duplicate creation yields one success and one `409`;
- duplicate creation never overwrites existing memory.

### Memory tests

- unscoped chat mounts only global and agent files;
- scoped chat mounts exactly global, agent, and selected project;
- inactive project memory is denied for read/write/list/glob/grep;
- project catalog listing does not reveal project memory contents;
- project marker ID/name survive agent edits and clear operations;
- project memory records support structured Add/Edit/Delete;
- Source remains read-only;
- injected-memory badges identify project records.

### Filesystem tests

- unscoped Chat A and Chat B use different namespaces;
- same agent + same project uses the same namespace across chats;
- different agent + same project uses different namespaces;
- same agent + different project uses different namespaces;
- project filesystem writes carry no expiry;
- unscoped filesystem writes retain configured expiry;
- clearing/deleting one project chat preserves shared files;
- client-supplied project IDs cannot redirect file access.

### Project history tests

- no project-history tools in an unscoped chat;
- scoped tools return only the authenticated owner's active-project chats;
- chats from other projects are excluded;
- chats owned by another user are excluded;
- `read_project_chat` rejects an arbitrary conversation ID;
- results are paginated and size-bounded;
- system/trace/hidden payloads are not returned;
- chats created by different agents in the same user project are discoverable.

### UI tests

- Project creation capability is independent of Memory in Agent Builder;
- project picker appears for every agent only when Projects are enabled platform-wide;
- sidebar Project creation follows the platform setting;
- `No project` remains usable when listing fails;
- selected project is immutable after conversation creation;
- create/duplicate tool results render Start chat actions;
- active Project label renders in chat and memory UI;
- file UI uses the server-resolved project namespace;
- removed namespace/MCP binding controls do not render.

### Regression tests

- global and agent memory behavior is unchanged;
- memory-off agents receive no memory middleware but retain platform Project
  selection, shared files, and history;
- unscoped filesystem isolation is unchanged;
- explicit workflow filesystem overrides still work;
- existing conversation transcripts and checkpoints remain conversation-scoped;
- shared-conversation ReBAC does not grant project access;
- schedules without projects continue working unchanged.

## Acceptance criteria

The feature is complete when all of these are true:

1. An administrator can enable Projects once for the whole platform without
   changing each agent, and an agent author may separately grant only Project creation.
2. A user or agent can create `Project A`, producing immutable ID `project_a` and the canonical
   placeholder memory file.
3. Creating any case/space-equivalent name is rejected without modifying the existing project.
4. A new-chat picker lists project names from existing project memory files.
5. An unscoped chat can list projects and, if granted, create them, but cannot
   access their memory, files, or chats.
6. A memory-enabled Project chat receives only that Project's memory and cannot
   access another Project's memory; memory-disabled agents still receive the
   Project workspace and history scope.
7. Project chats use `(agent_id, project_id, "filesystem")`; unscoped chats use
   `(agent_id, conversation_id, "filesystem")`.
8. Files created by one project chat appear in another chat using the same agent/project and do not
   expire under the normal six-hour filesystem TTL.
9. A project-scoped agent can list, search, and read bounded transcripts from the user's past chats
   in that project.
10. Selecting a repository-like project in a pod-capable agent does not trigger a platform-level
    assumption that the project is a pod; the agent decides whether an MCP record matches.
11. No dynamic namespace-source, key-path, label-path, or tool-binding controls remain in the
    Agent Builder.
12. No deployment is performed as part of implementation unless separately requested.

## Explicitly out of scope

- project types or subtypes;
- durable links from projects to MCP database IDs;
- automatic `get_pod` or other MCP bootstrap calls;
- automatic project creation by intercepting MCP results;
- `ensure_project`;
- project rename;
- project deletion;
- team-owned or shared projects;
- cross-agent shared filesystem files;
- automatic injection of every past project chat;
- copying prior chat messages into a newly scoped conversation.
