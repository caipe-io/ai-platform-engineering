# Implementation Plan: Refactor User Memory onto the deepagents Memory Library

**Branch**: `2026-08-05-memory-deepagents-refactor` | **Date**: 2026-08-05

> Superseded for working-context behavior by
> [Project Memory and Shared Workspaces](../2026-08-13-project-memory-shared-workspace/plan.md).

## Context

User memory is hand-rolled: a Mongo `user_memories` collection, a `UserMemoryService` data layer,
5 bespoke LLM tools, a bespoke prompt-injection path, and a second `user_memory_contexts`
collection driven by MCP tool-call interception. The same storage semantics are implemented
**twice** (Python `services/memory.py` + TypeScript `ui/src/app/api/user/memories/route.ts`) and
the index bootstrap exists **three** times with inconsistent sort order.

`deepagents==0.6.4` — already pinned, already building every agent graph — ships
`MemoryMiddleware`: markdown files loaded from a backend and injected into the system prompt, with
the model editing them via `edit_file`. Adopting it deletes the custom tool surface, the custom
injection path, the custom recall path, and the duplicated storage layer.

Nothing is deferred. This plan lands a complete, secure feature with no follow-up work.

## Core model

**A namespace is a working context, not a memory setting.** It is chosen when a conversation is
created and never changes. A **"Work on this pod" button** on a `list_pods` / `upsert_pod` tool
result opens a **new chat already scoped** to that namespace; the button is **optional** — ignore
it and keep working unscoped in the current chat.

Because the namespace is immutable per conversation, `sources` and the permission list are both
built once at graph construction and stay tight. No graph rebuild, no permission relaxation, no
mid-conversation switching machinery.

Three memory scopes, encoded as file paths under one user-scoped store namespace:

| path | mounted |
|---|---|
| `/memories/global/AGENTS.md` | always |
| `/memories/agents/<agent_id>/AGENTS.md` | always |
| `/memories/namespaces/<ns_key>/AGENTS.md` | iff this conversation has a namespace |

**Exactly 3 files ever mount.** No disabled file — delete replaces disable.

## Decisions

| # | Decision | Why |
|---|---|---|
| 1 | Namespace is set at conversation creation and **immutable**; a button opens a new scoped chat, and using it is optional | It's a working context; switching mid-chat smears memory across two contexts and would force either a graph rebuild or a permission relaxation (the latter being a confidentiality leak) |
| 1b | The new scoped chat carries **no prior messages** — only a `continued_from` link and the pod record from the triggering tool result | The reason for a new chat is that earlier turns were reasoned *without* the pod context; copying them drags that in along with other pods' tool results. The mounted namespace memory file is the continuity mechanism |
| 2 | Namespaces come only from dynamic `namespace_source` MCP tools | Real namespace sets are dynamic, caller-authorized data owned by an MCP (e.g. pods), not YAML or arbitrary user input |
| 3 | `namespace_scoped_tools` with `bind_arg` + `require_namespace` | The model must never supply the namespace identifier — see Security |
| 4 | Delete all 5 memory tools; agent uses `edit_file`/`read_file`/`grep` | −232 lines and the point of adopting the library |
| 5 | Owner key is the Keycloak **`sub`** | Email is mutable PII; `sub` is a UUID, which also removes deepagents' namespace-charset problem |
| 6 | Delete the MCP context-provider mechanism | Zero agents configure it; `namespace_source` + `bind_arg` is its inverse and strictly better |
| 7 | **No `enabled` flag.** Delete replaces disable, for both user and agent | Removes a file, a field, a UI control, a rail section, an endpoint, a cross-file merge rule, and today's silent re-enable bug |
| 8 | Dedicated GridFS bucket `agent_memory`, `ttl_seconds=0`, **2-tuple** namespace | Security and data-loss requirements — see Blockers |
| 9 | Our own `CaipeMemoryMiddleware(MemoryMiddleware)` via `middleware=[...]` | Need `memory_enabled` gating, per-turn reload, event emission, write interception |
| 10 | **Seed the 3 files on init** with a *visible* stub line | Eliminates the `write_file`-vs-`edit_file` branch and guarantees the model sees all three paths |
| 11 | One codec, in Python. The BFF route becomes a thin proxy | Otherwise the refactor recreates today's duplication as a TS codec that must byte-match a Python one |
| 12 | Reload memory **every turn** | The library caches once per thread; a memory written turn 3 is invisible turns 4..N, so the model re-saves it |
| 13 | Structured record Add/Edit/Delete over the file codec; raw `AGENTS.md` is read-only | Record IDs make individual deletion reliable; title collisions must be rejected rather than silently merged; raw writes would bypass those guarantees |
| 14 | **One size limit: 8,000 chars per file** | 3 files mount, so worst case is deterministic. A per-record cap only decides *how* the budget is used and fits badly with a text editor |
| 15 | `category` cut from the surface, preserved in the codec's `extra` | The heading organizes better; the agent will omit `cat=` and coerce to `preference`, making the badge misleading |
| 16 | `memory_id` remains stable across canonical rewrites | Stable addressing under concurrent rewrite + historical badge deep-links |
| 17 | Prompt-cache position accepted with a metric | See Accepted trade-offs |

## Blockers found and honored

1. **`fs_namespace` is client-supplied and unowned.** `routes/files.py:38-52` parses any 3-string namespace from the caller; the only guard is `Depends(get_user_context)` — authentication, no ownership check. Memory is unreachable via a **2-tuple** namespace (structurally rejected) **and** the dedicated bucket (`_get_gridfs_store` hardwires `gridfs_bucket_name`). The hole itself is closed in Phase 7.
2. **TTL would silently delete memory.** `services/gridfs_store.py:117-118` stamps `metadata.expireAt` on every put when `ttl_seconds > 0`; the existing store uses 21600s. Memory would vanish 6 hours after its last write with no error. Separate store instance at `ttl_seconds=0`, no TTL index on that bucket.
3. **deepagents provides no size control.** `MemoryMiddleware` downloads whole files, concatenates, injects. No char cap, token cap, or truncation. All limits are ours.
4. **A comment-only file is invisible.** `_format_agent_memory` does `stripped = _strip_html_comments(raw); if not stripped: continue` — so a header-only stub is dropped from the block and the model never learns the path exists.

## Architecture

```
create_deep_agent(
  backend = CompositeBackend(
      default = StoreBackend(store=self._store,        ns=(agent_id, session_id, "filesystem"))
                # or StateBackend() when backend_type == "state"
      routes  = {"/memories/": StoreBackend(store=self._memory_store, ns=(sub, "memory"))}
  ),
  permissions = [
      allow read+write  /memories/global/AGENTS.md
      allow read+write  /memories/agents/<this_agent_id>/AGENTS.md
      allow read+write  /memories/namespaces/<active_key>/AGENTS.md   # exactly one, or absent
      deny  read+write  /memories/**
  ],
  memory      = None,
  middleware  = [...existing..., CaipeMemoryMiddleware(...)],
  subagents   = [{..., "permissions": [deny /memories/**]}],
)
```

| | filesystem store | memory store |
|---|---|---|
| bucket | `gridfs_bucket_name` (`agent_files`) | `memory_gridfs_bucket_name` (`agent_memory`) |
| `ttl_seconds` | `_resolve_fs_ttl()` (21600) | **`0`** |
| TTL index | created at `main.py:100` | **not created** |
| namespace | `(agent_id, session_id, "filesystem")` — 3-tuple | `(sub, "memory")` — 2-tuple |

**The permission list is deliberately tight on `/memories/namespaces/`.** A broad
`allow /memories/namespaces/**` would let any memory-enabled agent `read_file` or `grep` every
namespace the user owns — a confidential namespace's notes leaking into an unrelated agent's
context. Only the active namespace is ever readable, and the immutable-per-conversation model is
what makes that expressible as a constructor argument.

Enforcement verified across `deepagents/middleware/filesystem.py`: `_check_fs_permission` on read
(8 sites) and write (4 sites), with `ls`/`glob`/`grep` **results filtered** (6 sites), on sync and
async paths. `FilesystemMiddleware`'s `NotImplementedError` guard only fires for
execution-capable backends; ours isn't one.

Subagents **inherit** the root's permissions (`graph.py:545`), so `_resolve_subagents` must set an
explicit deny per subagent dict or the root-only invariant silently breaks.

## On-disk format

Record delimiter is the **marker comment**, not the heading, so bodies may contain `##`, `---`, or
fenced code with zero escaping. Comments are stripped before injection, so markers are bookkeeping
the model never sees.

```markdown
<!-- caipe-memory:file v=1 scope=global -->
## Prefer concise answers
<!-- caipe-memory:rec v=1 id=mem_0a1b2c3d4e5f60718293 title=Prefer%20concise%20answers src=agent by=agent-abc created=2026-01-02T03%3A04%3A05Z updated=2026-02-03T04%3A05%3A06Z -->

Keep responses under 5 bullet points unless asked for detail.
```

Seeded / cleared state — byte-identical in both cases:

```markdown
<!-- caipe-memory:file v=1 scope=global -->
_No memories saved here yet._
```

- **Marker values percent-encoded** → cannot contain a space, `<`, `>`, or `--`, so a marker can never terminate early or look nested. Unknown keys round-trip via `MemoryRecord.extra`.
- **Body escaping: two digraphs** (`\<!--`, `\-->`, plus `\\`), provably reversible. Mandatory because `_HTML_COMMENT_RE` is **non-greedy** — an unescaped `<!--` would swallow the next record's marker.
- **The heading is what the model reads and edits; `title=` is authoritative for the UI.** A model that edits only the heading is healed on next parse.
- Blank-line canonicalisation gives `render(parse(render(f))) == render(f)`.

## Metadata maintenance

The middleware maintains metadata, not the agent. The agent writes plain markdown; the repair
pass adopts headings without markers (mint `id`, `src=agent`, `by=<agent_id>`,
`created=updated=now`), re-mints duplicate or malformed ids, and preserves unknown keys. The
pre/post parse in `awrap_tool_call` — already needed for the `memory_update` event — bumps
`updated=`. `src=manual` is only ever set by the REST API. `created=` is written once.

## Limits

**One number: 8,000 chars per file.** Enforced on every write (REST API, agent `edit_file`,
Markdown editor), shown as a live counter, blocking Add when exceeded. 3 files mount, so worst-case
injection is deterministic at 24,000 chars ≈ 6K tokens.

Rejected: a per-record cap (redundant — the file cap bounds the prompt; a per-record cap only
decides how the budget is used, and "section 3 is too long" is a poor error for a text editor);
record counts (a proxy that fought the real limit); an injection cap (could only fire when the file
cap was already violated, and forced a tail-dropping truncation whose omission notice risked the
model concluding a fact wasn't saved — dropping it deletes `render_budgeted`).

Existing over-budget files remain intact, are flagged in the dialog with a prune prompt, and are
counted by a metric.

This also fixes an inherited contradiction: today `MAX_VALUE_LENGTH = 4000` exceeds
`MAX_INJECTED_CHARS = 3500`, so a single maximum-length memory cannot be injected in full.

## Disabling

| Level | Mechanism | Default |
|---|---|---|
| **Agent** | `builtin_tools.memory.enabled`. Already `enabled_by_default=False`, already rendered as a Switch at `BuiltinToolsPicker.tsx:100` | **Off** — the author opts in |
| **Chat** | `memory_enabled` on the request, driven by the composer toggle; locks after the first user message | On, for memory-enabled agents |

Agent-level off is structural: no route, no middleware, no permissions, no seeding. Global included.

Chat-level off: `abefore_agent` returns `{}` with zero store I/O; `modify_request` returns the
request **unchanged** rather than the library's `"(No memory loaded)"` path, which still appends
~2.5KB telling the model to persist learnings it is forbidden to persist; `/memories/` writes are
refused.

## Namespaces

### Optional dynamic source

```yaml
builtin_tools:
  memory:
    enabled: true
    namespace_source:                                    # dynamic, from an MCP tool
      server: pod_meeting
      tool: list_pods
      args: { reason: "populate memory namespace picker" }
      key_path: "pods[].pod_id"
      label_path: "pods[].pod_name"
    namespace_scoped_tools:
      - server: pod_meeting
        tools: [find_prior_meeting_page, resolve_owners, do_final_task_check]
        bind_arg: pod_id
        require_namespace: true
```

`GET /api/v1/agents/{id}/memory-namespaces` invokes the configured tool with the **user's** bearer
via the existing `services/mcp_client.py` and returns `[{key, label}]`, short-TTL cached. If the
MCP is unreachable the picker errors and "None" stays valid — **never block chat start**.

### Security chain

`list_pods` → `list_visible_pods(subject)` → `pod_visibility_filter(subject, …)` in
`clients/pod_meeting_mongo.py`, so the picker only offers namespaces the caller may see. The
selected key is re-validated against a fresh call at conversation creation. `bind_arg` then strips
`pod_id` from the schema the model sees and injects the validated key.

**The model never supplies a namespace identifier**, so it cannot reach a namespace the user can't
see, and a prompt injection cannot redirect it. No new authz model and no OpenFGA namespace type —
the MCP stays the authority, and we stop letting the LLM launder its own output back into tool
args. Because the namespace is immutable per conversation, the bound value is a constant resolved
at graph build.

### Entering a namespace

- **"Work on this pod"** renders on `list_pods` and `upsert_pod` tool results. Click → **new conversation** with `metadata.memory_namespace` preset and `metadata.continued_from` set; both ends show *"continued from …"*.
- **The button is optional and non-modal.** Ignoring it leaves the current chat unscoped and working normally. There is no forced choice and no interruption.
- **No prior messages are carried.** The new chat opens with the pod record from the triggering tool result as its opening context, nothing else. No message copy, no LLM-generated summary (which would add latency on click and could get it wrong). The mounted namespace memory file provides the real continuity.
- The composer picker remains as a secondary path for starting a chat already scoped.
- `POST /api/chat/conversations` validates the key against the agent's resolved list; `PUT` rejects mutation. Requests carry a typed `memory_namespace` field mirroring `memory_enabled` — **not** `client_context`, which is documented as opaque and rendered into the system prompt via Jinja.

### Configuring `namespace_source` and bindings from the UI

The UI already receives MCP tool input schemas (`inputSchema`/`input_schema`,
`ui/src/types/dynamic-agent.ts:133-134`), so this is two steps, not
hand-written YAML:

1. **Pick the list tool** from a dropdown of the server's tools, then call it once with the user's token and let the user click the id and label fields in the sample response — no path syntax to learn. Fallback to typing `key_path`/`label_path` if the server is unreachable or the tool needs args the user can't supply (MCPs rarely publish output schemas).
2. **Confirm auto-suggested bindings.** Once the key field is known, scan every other tool's `inputSchema` for an arg of that name and pre-check it. Name matching does most of the work because MCPs are internally consistent about identifier names; the user unchecks exceptions (e.g. `get_pod`, which should inspect any pod). `require_namespace` is a per-tool checkbox defaulting on for bound tools.

The optional section is collapsed by default. Its server picker contains only
servers selected under MCP Tool Access. A missing configured source is retained
and shown as a blocking validation error; the editor never silently enables,
locks, or clears an MCP server.

The generated YAML is shown before save — nothing is inferred silently, and it stays hand-editable.

## Manage Memory UI

```
┌─ Manage Memory ──────────────────────────────────────────────────┐
│ ACTIVE IN THIS CHAT │ Global memory       [Memories][Source] │
│ Global          5   │ /memories/global/AGENTS.md                  │
│ Agent: incident 3   │ 2.1 / 8 KB            Updated 2 min ago     │
│ NS: pod-sre-core 2  │ ──────────────────────────────────────────  │
│                     │ ┌───────────────────────────────────────┐   │
│ OTHER               │ │ Prefer concise answers         manual │   │
│ Agent: deploy-bot 4 │ │ Keep responses under 5 bullets.       │   │
│ NS: checkout      7 │ │                          [Edit][Del]  │   │
│ NS: legacy-ns  0 🗑 │ └───────────────────────────────────────┘   │
│                     │ [+ Add memory]                    [Clear]   │
└──────────────────────────────────────────────────────────────────┘
```

**Structured record editing, with a read-only source view.** The codec parses
server-side for event IDs, repair, deep-links, and normalized-title conflict detection. `GET`
returns file text and parsed `records[]`; rail counts include records and freeform preamble. Normal
Edit patches one record by ID. Add rejects a title already present in that file and offers to edit
the existing record; no title collision silently merges bodies or metadata.

The parse is lenient: a `##` heading without a marker is adopted; text above the first heading
becomes `preamble`. So counts always match visible `##` sections. A file with no headings shows 0
records plus a freeform-content note.

- **Rail lists every file** the user owns under `(sub, "memory")` via `store.search(namespace_prefix=(sub,"memory"))`, split Active / Other, Other sorted by most-recently-updated. This preserves today's behavior — the dialog's own fetch passes no scope filter, so it already shows everything — and makes inactive namespace files visible and prunable. It is also the only place to manage memory for an agent you're not currently chatting with.
- **Memories is the default mode.** Per-card badge says whether the user or agent added the record.
- **Source** shows raw `AGENTS.md` read-only with Copy and Download.
- **Structured Edit:** required title/body fields call `PATCH {path, memory_id, title, body, etag}`; the stable ID and creation provenance survive title/body changes.
- **Raw whole-file write:** a non-empty `PUT {path, text, etag}` is rejected. On an etag 409 during
  a structured operation, reload the latest file before retrying; there is no overwrite path.
- **Add and Delete:** `POST` appends a uniquely titled record; `DELETE ?id=&etag=` drops one section. A duplicate-title 409 identifies the existing record so the UI can offer Edit existing or let the user choose another title.
- **Empty `PUT`:** mounted files reset to the stub (**Clear**) and are never deleted, since the model must always see their paths; unmounted files have their store key **deleted**, since that's where junk accumulates and nothing seeds them.
- **Deep-link from a badge** opens the file containing the first matched id, highlights all matches, badges other rail items containing matches. A stale id scrolls to nothing.
- **Live change while open** shows a non-blocking *"Memory changed — Refresh"* chip. Never auto-reload; it would discard an in-flight edit.

Users never need to know markers exist — plain `## Heading` + body is adopted on next read.

## Phases

**1 — Pure modules** (unit-testable, mergeable alone)
1. `services/memory_paths.py` (~60): `memory_owner_key(user)` (`sub`; email only under `DEBUG`), `memory_store_ns(sub)`, `global_source()`, `agent_source(id)`, `namespace_source_path(key)`, `is_memory_path(path)`, `validate_namespace_key(key)`, `SEED_TEMPLATE`.
2. `services/memory_codec.py` (~260): `MemoryRecord`, `MemoryFile`, `parse`, `render`, `new_memory_id`, unique-title validation, escaping.
3. `config.py`: `memory_gridfs_bucket_name="agent_memory"`, `memory_max_file_chars=8000`. Remove `user_memory_contexts_collection`.

**2 — Identity**
4. `ui/src/lib/da-proxy.ts:127-135`: add `sub` to the `userContext` object (already computed at `:141`).
5. `ui/src/lib/server/workflow-da-auth.ts:26`: same.
6. `auth/jwt_middleware.py`: stash the `sub` claim it currently logs and discards into a ContextVar beside `current_user_token`.
7. `models.py` `UserContext`: explicit `sub: str | None = None`.

**3 — Middleware**
8. `services/memory_middleware.py` (~230): `sources` as a property over a provider callable. `abefore_agent` always reloads, lenient parse, lazy repair, **catches all errors and degrades to `{}`** (the library raises `ValueError` on any non-`file_not_found` error, which would kill every turn on a Mongo blip). `modify_request` skips entirely when disabled. `awrap_tool_call` detects `/memories/` writes, refuses when disabled, diffs record-ID sets for a real `action`, sets a dirty flag for intra-turn refresh.
9. `CAIPE_MEMORY_SYSTEM_PROMPT`: derived from the library's, **must keep the `{agent_memory}` slot**. Names the three writable paths explicitly, states the global-vs-agent-vs-namespace routing rule, says to replace the stub line on first write, and steers `grep` to explicit paths.

**4 — Runtime wiring** (`services/agent_runtime.py`)
10. `__init__`: `self._memory_store = MongoDBGridFSStore(bucket_name=settings.memory_gridfs_bucket_name, ttl_seconds=0)` from the shared Mongo client **independent of `ephemeral`**, so `/invoke` and scheduled runs get memory (today they silently get none). Assert `ttl_seconds == 0`. Delete the `UserMemoryService` construction.
11. `initialize()`: `CompositeBackend`; build the tight permission list; **seed any missing mounted file** with `SEED_TEMPLATE`; append the middleware. Reuse the `StoreBackend(store=..., namespace=lambda runtime: ns)` pattern at `services/agent_runtime.py:1007-1010`.
12. `_resolve_subagents`: explicit `/memories/**` deny per subagent dict.
13. `namespace_scoped_tools`: filter tools when no namespace is active; wrap the rest so `bind_arg` is injected from the active key and stripped from the model-visible schema.
14. `create_format_file_tool`: explicit error for `/memories/` paths — it's bound to `fs_ns` and would otherwise read the wrong namespace.
15. Extend `services/skill_scrubber.py` to scrub `memory_contents` from spans as it scrubs `skills_metadata` — it's a checkpointed channel (`PrivateStateAttr` hides it from I/O *schemas* only) and bodies are user PII.
16. **Delete** (~260 lines): `_wrap_context_provider_tools`, `_extract_tool_args`, `_decode_tool_result_content`, `_extract_display_name`, `_append_tool_memory`, `build_memory_prompt_message`, `_drain_memory_context_used_ids`, the memory-tools branch, the first-turn injection block, the `UserMemoryService` import.

**5 — API + encoders**
17. `models.py`: delete `MemoryContextProviderConfig`; `MemoryToolConfig` → `{enabled, namespace_source, namespace_scoped_tools}`; `memory_namespace` on `ChatRequest`. Keep `context_providers` readable-and-ignored for one release.
18. `routes/chat.py`: `memory_namespace` on `ResumeStreamRequest`; fail-closed validation; thread through all 6 stream/resume call sites.
19. `routes/memories.py` (~130): `GET /api/v1/memories` (all files + parsed records + etags), `PUT` (empty clear/delete only; reject non-empty text), `POST` (append), `PATCH` (record ID + title/body + etag), `DELETE ?id=&etag=`. Owner from `Depends(get_user_context)`, **never** the body; no endpoint accepts a store namespace. `StoreBackend` is unusable here (`get_store()` needs a graph run) — talk to `BaseStore` directly.
20. `routes/agents.py`: `GET /{id}/memory-namespaces` resolving `namespace_source` via the user's bearer, short-TTL cached.
21. Encoders: add `on_memory_update(memory_ids, action)`; delete the `_memory_update_payload` JSON-sniffing hack from both and `on_memory_context_used` entirely.
22. `builtin_tools.py`: delete `create_memory_tools`; rewrite the `memory` `BuiltinToolDefinition`.
23. `services/mongo.py`: delete the memory index block.

**6 — Scheduler**
24. `memory_namespace: str | None` on `ScheduleVersion`, `ScheduleCreate`, `SchedulePatch`, `Schedule` in `caipe_scheduler/models.py` (all four already carry `agent_id`), validated against the agent's resolved list; surfaced in the schedule form, defaulting to the originating conversation's; forwarded by `/api/v1/chat/invoke`.

**7 — Security hardening**
25. Ownership guard on all 5 `/files/*` endpoints: resolve `namespace[1]` as a conversation and require the caller to own it.

**8 — UI**
26. **First, alone:** extract `MemoryDialog` out of `ui/src/components/chat/DynamicAgentChatPanel.tsx:2464-2778`. Pure move — that file is 3185 lines and hot.
27. Rebuild `MemoryDialog` on the rail + Memories/read-only Source design.
28. `MemoryNamespacePicker` in the composer; the optional "Work on this pod" button on `list_pods`/`upsert_pod` tool results, which creates a new scoped conversation seeded with the pod record and a `continued_from` link; *"continued from …"* affordance on both conversations.
29. `MemoryToolSection` in `BuiltinToolsPicker`: `namespace_source` wizard + auto-suggested bindings. Needed because `BuiltinToolConfigField.type` is only `string|number|boolean`, so a list of objects can't ride the generic renderer.
30. Thread `memoryNamespace` through `streaming/callbacks.ts` → both browser consumers → the panel's three send paths.
31. **Fix `ui/src/components/chat/ChatContainer.tsx:163-180`** to carry `conv.metadata` — the deep-link path drops it, so a refresh would lose the namespace client-side while the cached runtime still has it.
32. Delete `memory_context_used` end-to-end but **keep its parse branch** remapped into `memoryInjectedData` — persisted transcripts still contain those events.
33. Delete the TS validators in `ui/src/app/api/user/memories/route.ts` (202 → ~90, now a proxy), `UserMemory` from `types/mongodb.ts`, `MemoryContextProviderConfig` from `types/dynamic-agent.ts`, the dead `MEMORY_ENABLED_KEY`/`isMemoryEnabled()` shims in `settings-panel.tsx`, and the orphaned "Cross-Thread Memory" flag in `ui/src/store/feature-flag-store.ts:30-42` which points at a nonexistent docs page and ships a second competing memory toggle. All verified zero-consumer.

**9 — Docs**
34. Rewrite `docs/docs/features/user-memory.md` and `docs/docs/architecture/user-memory-design.md` per `CLAUDE.md` rules. Replace the `context` scope row with `namespace`; delete the `context_providers` example; add a Concurrency section with a diagram.
35. `docs/src/pages/features.tsx:105` ("Agent tools for remember, recall, update, list, and forget" is no longer true); add a memory section to `dynamic_agents/SSE_EVENTS.md`.
36. Release note: `memory_context_used` removal, the new `memory_namespace` field, `category` removal, **`enabled`/disable removal** (docs currently promise "enable or disable a record without deleting it"), and that `interrupt_on: {builtin: {remember}}` no longer applies (grep confirms zero usage; path-scoped write approval is not expressible in 0.6.4 since `interrupt_on` keys on tool name).

## Accepted trade-offs

- **Prompt-cache position.** The library appends `AnthropicPromptCachingMiddleware` at `graph.py:718` and its own `MemoryMiddleware` at `:719`, so memory sits *inside* the breakpoint; anything passed via `middleware=[...]` lands at `:710`, the wrong side. `_REQUIRED_MIDDLEWARE` protects only `FilesystemMiddleware` and `SubAgentMiddleware`, so the caching middleware *is* excludable via `HarnessProfile.excluded_middleware` and could be re-added ahead of ours — but profile exclusion also applies to the general-purpose subagent stack, trading a certain regression on subagent turns for a smaller one on the root. **Keep the single subclass, `add_cache_control=False`, accept the position.** Cost: the root agent's prefix cache misses once per memory write, ~1–3 turns per conversation; subagents unaffected. Counter added. The exclusion lever is documented as the escape hatch.
- **`grep(path="/")` fans into the memory store.** Results are permission-filtered so nothing leaks; the residual is latency, covered by the prompt and the existing turn-latency metric.
- **Scoped work means more conversations.** Five pods in a day is five chats. Correct rather than costly — pod work should be separable and a per-pod transcript is more useful than one mega-thread — but it changes how the chat list feels. Mitigated by the button being optional: unscoped work stays in one chat.
- **A namespace cannot be changed mid-conversation.** Deliberate. The alternatives were a graph rebuild (feasible but adds a code path whose failure mode is latency) or relaxing `permissions` to `/memories/namespaces/**` (rejected — it lets any memory-enabled agent `read_file`/`grep` every namespace the user owns, leaking a confidential namespace into an unrelated agent's context).
- **Enable/disable is gone for both user and agent.** Delete is the only removal.

## Verification

Python — `uv run ruff check`, `uv run pytest`:

- `tests/test_memory_codec.py` — round-trip identity; idempotence; adversarial bodies (`<!--`, `-->`, a fake marker, `\`, `##` at column 0, fenced code containing all of it, CRLF, CJK/emoji). **Key assertion: import `deepagents.middleware.memory._strip_html_comments` directly** and assert the stripped render contains every body verbatim and no markers. Lenient repair. Unicode-aware unique-title rejection. **Seed and Clear produce byte-identical content.** **A comment-only file is skipped by `_format_agent_memory` while the stub is not** (pins Blocker 4).
- `tests/test_memory_paths.py` — namespace is a 2-tuple and `routes.files._parse_namespace` rejects it (pins Blocker 1); every component passes deepagents' `_validate_namespace`; key validation rejects `..`, `/`, leading `-`, 65 chars, uppercase.
- `tests/test_memory_middleware.py` — **`ttl_seconds=0` writes no `metadata.expireAt` while 21600 does** (pins Blocker 2); two-user isolation including that A's `edit_file` is invisible to B; `memory_enabled=False` does zero store reads and leaves the system message free of `MEMORY_SYSTEM_PROMPT` markers; reload-each-turn sees an external write; dirty refresh mid-turn; error containment (backend raises → turn proceeds, `{}`, warning logged); `memory_update` action diff; a non-empty file parsing to 0 records is never written back.
- `tests/test_memory_permissions.py` — **an inactive namespace is denied for read *and* write, and is absent from `ls`/`glob`/`grep`** (pins the confidentiality property); another agent's file denied; subagent dicts carry the deny; `supports_execution(CompositeBackend(...))` is `False`. **Also pin that `abefore_agent`'s download bypasses `permissions`**, so nothing may ever enter `sources` that shouldn't be injected.
- `tests/test_memory_namespaces.py` — `bind_arg` is stripped from the model-visible schema and injected from the active key; a model-supplied value is ignored; `require_namespace` tools are absent with no namespace; an undeclared key fails closed at conversation creation.
- `tests/test_memory_limits.py` — the file cap is rejected at write with an actionable error; an existing over-budget file loads intact and is flagged.
- `tests/test_files_authz.py` — a caller cannot address a conversation namespace they don't own (Phase 7).
- Regression pin: `delete_by_key_prefix(fs_ns, "/skills/")` and `delete_by_namespace((agent_id, conv_id, "filesystem"))` leave the memory bucket untouched.
- Delete `tests/test_user_memory.py`.

UI — `cd ui && nvm use && npm run lint && npm run build && npm test` (**jest**, not vitest):

- Update `streaming/__tests__/agui-protocol-memory.test.ts` and `custom-adapter.test.ts` for the removed `memory_context_used` and the new `memory_namespace` field.
- New: legacy `memory_context_used` transcripts still render a badge; the `user-memories` proxy (401 envelope, 503 passthrough, etag forwarded, 409 forwarded, owner never read from the body); `memory_namespace` validation on conversation create; `MemoryNamespacePicker`; the binding auto-suggest derived from `inputSchema`; `MemoryDialog` (Active/Other rail, Memories/read-only Source switch, non-empty raw PUT rejected, Clear vs Delete per mounted/unmounted, over-budget blocks Add, deep-link highlights across files).
- E2E (`ui/e2e/rbac/`, mocked): `chat-memory-namespace.spec.ts` — picker renders from a mocked `memory-namespaces` response, `stream/start` carries `memory_namespace`, the "Work on this pod" button creates a new scoped chat seeded with the pod record and carrying no prior messages, **ignoring the button leaves the current chat unscoped and usable**, **the namespace survives a reload** (the `ChatContainer` regression), picker absent when none are declared. `chat-memory-manage.spec.ts` — rail renders Active/Other, Source is read-only, 503 retry banner, badge deep-link highlights.

End-to-end smoke: Compose up; enable memory on a test agent with `namespace_source` pointed at a
stub MCP; confirm the picker populates; start a chat, ask the agent to remember something, confirm
the markdown in `agent_memory` has **no `expireAt`**; start a second chat and confirm injection;
click "Work on this pod" and confirm the new chat has only that namespace's file readable while another namespace's
is denied to `read_file` and absent from `grep`; edit a structured record and confirm the agent
sees it next turn; confirm raw Source cannot be edited; delete a record and confirm it leaves the prompt.

## Landing order

Phase 1, Phase 2, and task 26 are independent and unblocked — land first. Then 3 → 4 → 5 → 8,
with 6 and 7 anytime after 5, Phase 9 after 5, and task 36 last.
