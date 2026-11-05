---
sidebar_label: Claude ACP
sidebar_position: 18
---

# Claude ACP in CAIPE

Claude ACP is a first-party Agent Builder and chat integration. It uses the
same conversations, sharing controls, tool timeline, Stop action and reconnect
flow as other CAIPE agents. The integration is experimental.

| Agent Builder option | Execution | Harness ID |
|---|---|---|
| Claude Agent SDK (ACP) | Upstream `claude-agent-acp` adapter using Claude Agent SDK | `claude_code_acp` (preserved for existing agents) |
| Claude Code CLI (ACP) | CAIPE ACP adapter launching the pinned `claude` executable directly | `claude_code_cli_acp` |

Both use Harness Gateway authorization, Engine-owned runs and cursor replay.
They have separate worker profiles, databases and persistent workspace volumes.
Adding the CLI does not migrate or rebind existing SDK conversations.

See the [Claude ACP threat model](../security/claude-acp-threat-model.md) for
credential lifetimes, trust boundaries, required deployment controls and residual risks.

## Agent author workflow

1. Select **Claude Agent SDK (ACP)** or **Claude Code CLI (ACP)** and an available
   **Operator profile** in Agent Builder.
2. Write the agent instructions and choose individual MCP tools in **Tools**.
3. Save the agent and start a chat. The **Claude** control in the chat header
   shows response activity. Open it for persistence and shared-viewer details.
   API-connected chats show a compact **API** control with connection details.
4. Refresh or reopen the chat to reconnect to the server-owned run. Starting
   another browser subscription does not start another Claude process.
5. **Stop** cancels the current response and keeps the chat open. While an
   already-dispatched tool drains, the composer shows **Stopping** and waits
   for server confirmation before sending another prompt. Refresh preserves
   that state. Confirmed cancellation is shown as **Stopped**, not an error.

Model access and workspace policy are deployment settings. Agent authors cannot
supply a worker URL, executable command, provider credential or permission bypass.
Existing conversations retain their pinned execution configuration when an
agent's default harness changes.

## Authentication and authorization

```mermaid
flowchart LR
    U[Browser] -->|App sign-in| B[CAIPE BFF]
    B -->|Agent and conversation actions| C[CAS]
    B -->|Private service credential and verified caller| E[Harness Engine]
    E -->|Private authenticated ACP| W[Claude worker]
    W --> A[Claude ACP process]
    A -->|Run-scoped loopback MCP capability| T[Worker tool bridge]
    T -->|Original caller bearer| B
    B -->|Signed agent context and caller| G[AgentGateway]
    G -->|Tool authorization| C
    G --> M[MCP servers]
```

| Boundary | Authentication | Authorization |
|---|---|---|
| Browser → BFF | Existing OIDC session or accepted caller bearer | CAS agent use and conversation write for execution; conversation read for shared replay |
| BFF → Engine | Deployment-managed internal service credential | Verified caller subject; exact conversation read scope cannot mutate a run |
| Engine → worker | Private allowlisted endpoint and distinct worker service credential | Original run ID, subject, binding and immutable agent version; worker rejects inconsistent contexts |
| Claude process → tool bridge | Random capability for one run, accepted only on loopback | Only pinned tool aliases; capability is removed when its turn ends |
| Worker → BFF → AgentGateway | Original caller bearer and signed real-agent context | Current agent availability, agent-use and conversation-write access, pinned tool bindings, current agent tool policy and MCP invocation grants are checked on every call |
| Worker → model provider | Operator-supplied provider credentials or supported workload identity | Provider IAM/model policy and configured model profile; independent of the user's app sign-in |

- CAS is the authorization boundary. It does not replace OIDC authentication.
- AgentGateway routes MCP traffic and enforces its caller/agent tool policy.
  ACP does not grant tool access by itself.
- The Claude process receives neither the user's bearer token nor the worker's
  internal service credential. Its MCP capability cannot invoke another run or
  expand the selected tool set.
- Provider-backed MCP servers resolve the execution caller's own connected
  credential in the BFF. The user's app token authenticates to AgentGateway;
  the provider token travels separately on `X-CAIPE-Provider-Token` and is
  forwarded according to the MCP route's upstream authentication policy.
- When AgentGateway caller-tool checks are enabled, the caller also needs
  `call` permission on each selected `tool:<server-id>/<tool-name>`. The
  Access API accepts these exact tool IDs for grants, checks and revocation;
  an agent-use grant or a connected account alone does not grant tool access.
- Shared readers may follow a response without agent-use permission. Sending,
  stopping and invoking tools retain the execution-owner and write checks.
- MCP calls are not automatically retried after an ambiguous result. Dispatched
  calls drain before the session reservation is released.
- Claude's MCP execution and idle limits are 15 minutes, below the broker's
  16-minute request limit. Automatic MCP backgrounding is disabled so the turn
  waits for its dispatched tools, including across browser refreshes.
- Selected MCP tools currently require `approval_policy: never`. Interactive
  tool approvals and user-input forms are not supported by this integration.
- Native workspace/shell tools are disabled by default. If an operator enables
  them, they run under the worker's OS/filesystem boundary; they do not pass
  through CAS or AgentGateway. CAS is not a filesystem sandbox.

## Deployment

Use the optional `deploy/harness-engine/compose.claude-acp.yaml` overlay with
the base Compose file, `compose.deep-agents.yaml`, and the shared
`compose.worker-egress.yaml` overlay loaded once. Published images and model-host
configuration are described in the [deployment guide](https://github.com/caipe-io/ai-platform-engineering/blob/main/deploy/harness-engine/README.md). The standard OSS install
profiles do not enable this worker.

For the CLI, add `deploy/harness-engine/compose.claude-cli-acp.yaml` instead, or
alongside the SDK overlay. Its image pins Claude Code CLI `2.1.317`; it does not
use an Agent SDK query client to execute prompts.

- Set a distinct `CLAUDE_CLI_ACP_WORKER_INTERNAL_TOKEN` and
  `CLAUDE_CLI_ACP_PROFILES_JSON` model/workspace profile.
- Add a separate Engine worker connection with `runtime: claude_code_cli_acp`,
  URL `http://claude-cli-acp-worker:8010`, its token and its local profile ID.
- `CLAUDE_CLI_ACP_NATIVE_TOOLS` is an operator-owned JSON list, empty by default.
  For example, `["Read","Glob","Grep"]` enables native read tools. Native tools
  execute in the worker's OS/workspace boundary, independently of MCP/CAS grants.
- The CLI runs without `--bare`. Explicit tool permissions, strict MCP configuration
  and no permission bypass still apply. Settings-file discovery, automatic
  `CLAUDE.md` loading and slash commands remain disabled by the separate settings
  policy. Agent instructions append to the CLI's own prompt.
- The worker translates CLI streaming text/tool events into ACP. Each turn uses
  `--session-id` or `--resume` with the same saved native UUID. An absent transcript
  fails instead of silently starting a new conversation.
- Run-scoped MCP capabilities and instructions use private temporary files,
  removed when the CLI exits. User/provider credentials never enter CLI arguments.

- `CLAUDE_ACP_WORKER_INTERNAL_TOKEN`: distinct private worker credential.
- `CLAUDE_ACP_PROFILES_JSON`: local model/workspace profiles, for example
  `{"safe":{"model":"<approved-model-id>","cwd":"/workspace","permission_mode":"dontAsk"}}`.
- Add the corresponding connection to `HARNESS_ENGINE_CLAUDE_WORKER_PROFILES_JSON`:

```json
{
  "primary": {
    "url": "http://claude-acp-worker:8010",
    "token": "<worker-service-credential>",
    "profile_id": "safe",
    "runtime": "claude_code_acp",
    "tools_enabled": true,
    "description": "Managed Claude session with selected MCP tools"
  }
}
```

Use private networking or HTTPS between services. Run the container with an
init process (`init: true` in the overlay) so provider children are reaped;
the worker drains the dedicated process group before releasing a run. Mount its
persistent workspace volume and configure the BFF tool broker URL. The optional image pins
the upstream Claude ACP executable. Instructions, model options and selected
MCP tools are supplied through ACP session setup; built-in tools and settings
discovery remain restricted by operator policy.

The Engine exposes the SDK connection as the `claude_code_acp` harness. Older
`claude_agent_sdk_remote` blueprints selecting the same connection remain valid.

## Persistence boundaries

- Engine bindings and canonical event journals live in MongoDB.
- Native Claude ACP transcripts live on the worker's persistent workspace volume.
  They are not mirrored by the Python SDK's Mongo transcript store.
- Reloading the browser replays Engine events. Replacing an idle worker can load
  the native transcript when the same workspace volume is available.
- In-flight process takeover after a worker failure is unsupported. An uncertain
  producer retains its reservation until operator reconciliation.
- The network leg is a private HTTP/NDJSON ACP v1 transport with the negotiated
  Harness extension, not the proposed standardized ACP Streamable HTTP transport.
