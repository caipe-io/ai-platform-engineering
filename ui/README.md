# CAIPE UI

Next.js BFF and web UI for CAIPE. The UI talks to Dynamic Agents through
server-side API routes, manages MongoDB-backed chat state, and exposes admin
surfaces for models, MCP servers, skills, credentials, RBAC, audit logs, and
platform health.

## Quick Start

From the repository root:

```bash
make caipe-ui-dev
```

Or run directly (requires Node.js 24.22.1 or newer, below 25):

```bash
cd ui
nvm use   # if available
npm ci
npm run dev
```

Open http://localhost:3000.

## Runtime Configuration

Settings > Appearance > Interface shadows lets each user turn decorative box
and text shadows off. Shadows are disabled by default; the preference saves to
the account and applies immediately, including shared chat and SDK-connected
iframe apps. Borders, focus rings, theme colors, and glass transparency remain.
Glass (enabled by default) and chat text size are user Appearance preferences,
not conversation actions. Existing device choices are retained until a saved
account preference is available. App default text size follows each app’s
presentation configuration.

| Variable | Default | Purpose |
|---|---|---|
| `DYNAMIC_AGENTS_URL` | `http://localhost:8100` in local dev, `http://dynamic-agents:8100` in production | Server-side Dynamic Agents runtime URL |
| `MONGODB_URI` | unset | Required for SSO sessions; also enables conversations and admin state |
| `MONGODB_DATABASE` | unset | Required with `MONGODB_URI` for SSO |
| `PROMETHEUS_URL` | unset | Server-side Prometheus-compatible query URL for Admin metrics and health. In HA deployments, use a deduplicating query frontend such as Thanos rather than a load-balanced service over independent Prometheus replicas. |
| `RAG_SERVER_URL` | unset | Server-side RAG API URL |
| `NEXTAUTH_SECRET` | unset | Required for authenticated deployments |
| `SSO_ENABLED` | `false` | Enables OIDC-backed auth |

Browser chat traffic goes through the BFF routes under
`/api/v1/chat/stream/*`; the browser does not call the Dynamic Agents service
directly.

SSO sessions use the shared `auth_sessions` collection, not process-local token
caches. All BFF replicas need the same `NEXTAUTH_SECRET`. Session-format upgrades
require a coordinated cutover and a fresh login; existing grants are unchanged.
See [browser-session architecture and rollout](../docs/docs/security/browser-sessions.md).

`OIDC_TOKEN_ENDPOINT` optionally overrides the server-side refresh endpoint.
Without an override, an internal Keycloak realm URL in `OIDC_DISCOVERY_URL` uses
its local token path; other providers use their discovery document. Generic
provider discovery failures never fall back to a Keycloak URL.

Refresh discovery and token requests reject HTTP redirects. Discovered token
endpoints cannot downgrade HTTPS to HTTP; an explicit internal HTTP endpoint
remains supported. Endpoints reject embedded credentials and URL fragments.
Malformed token responses never replace stored credentials and follow the
existing ambiguous-response recovery rules.

Rejected refresh credentials are suppressed across replicas while a still-valid
access token finishes its lifetime. Definite retryable failures use a shared
60-second cooldown. A lost or ambiguous refresh response retains the existing
lease protection against replaying a potentially consumed rotating token.

Run the real MongoDB coordination tests with
`AUTH_SESSION_TEST_MONGODB_URI=mongodb://127.0.0.1:27017 npm test -- --runInBand src/lib/__tests__/auth-session-mongo.test.ts`.

Browser fixtures must seed a session record through `e2e/rbac/_session-cookie.ts`.
Self-contained cookies, including those from the older `mint-test-session.mjs`
benchmark helper, are deliberately rejected. Benchmarks should use a real OIDC
login session until that helper is migrated.

### Live chat viewers

- The chat header shows unique viewers and their open browser session count. Select the indicator to see names and session counts.
- The full chat and in-app panel share one presence connection within a page. Separate tabs, windows, and browser profiles count separately, including background tabs.
- Presence uses the conversation's existing read permission. Authenticated identities are supplied by the BFF; viewing does not grant permission to execute or stop a run.
- BFF replicas share short-lived MongoDB `conversation_viewers` leases. Updates arrive over a separate SSE subscription every five seconds; permission and session validity are rechecked every fifteen seconds.
- Lease renewal runs independently of roster queries. Disconnects remove the lease; crashed connections expire after thirty seconds. Queries exclude expired leases, and active subscriptions reclaim them every minute even if the TTL index is unavailable.
- Failed presence connections retry with exponential backoff from five seconds to one minute. A valid roster resets the backoff.
- This is conversation presence, independent of execution-stream subscribers, durable run events, and replay cursors. It requires MongoDB storage.

### Live chat navigation

- The top-right **Live Agent Chat** control counts every streaming chat, including the current chat. Its green dot pulses unless reduced motion is requested.
- One chat shows its title and links directly to that conversation. Multiple chats open a titled list with individual links and a current-chat marker.
- App-owned recovery observations are deduplicated against browser streams. Saving responses remain listed until recovery completes.
- Opening the list focuses the first chat; Tab reaches other destinations and Enter opens them. Escape returns focus to the trigger.
- Ordinary navigation preserves the shared unsaved-editor guard; modified clicks retain native new-tab/window behavior. The list uses the shared `Popover` for navigation rather than a form selection control.

### Migrate an existing conversation

- Eligible Deep Agents chats show **Migrate to Harness Engine** above the messages. Conversation write access and agent-use permission are required.
- Migration preserves messages, LangGraph checkpoints, files, and pending approvals. Future responses run independently of browser refreshes; existing LangGraph history was already persistent.
- Active Engine responses do not trigger the chat's browser refresh warning after the server confirms run admission. Legacy streams and requests awaiting admission keep the warning.
- Finish or stop an active execution first. Both Engine reservations and the native checkpoint's producer lease are checked; the native execution fence also protects the handoff from concurrent requests.
- Confirm the migration in the dialog. The current draft stays in place and no prompt or approval is submitted.
- If the connection is interrupted, reopen the chat and select **Resume migration**. The server reuses the original handoff rather than creating a second execution.
- The action is hidden for Engine-managed chats, app-owned assistants, other harnesses, read-only history, and deployments without the Deep Agents integration enabled.

### Agent Builder harness controls

- Deep Agents retains its model, tools, knowledge, skills, and Advanced controls.
- Engine-backed agents use an operator profile for their execution model. Schema-declared harness options appear under Advanced.
- Tools appear only when the harness declares supported tool bindings. Both current Claude SDK and AgentCore adapters report builder tool bindings unavailable.
- An optional writing-assistant model powers AI Suggest without changing the agent's execution model.
- `/api/dynamic-agents` requires `model` for Deep Agents. Engine-backed metadata may omit it; switching back to Deep Agents requires a valid model.
- Saved Deep Agents settings remain in metadata while another harness is selected and are excluded from its execution blueprint.

See [Agent Creation UI Architecture](../docs/docs/specs/2026-08-17-harness-engine/agent-creation-ui.md) for the authoring flow and runtime profile contract.

## Development Commands

```bash
npm run lint
npm test
npm run build
```

For Docker Compose:

```bash
COMPOSE_PROFILES=caipe-ui,dynamic-agents,caipe-mongodb docker compose -f ../docker-compose.dev.yaml up --build
```

## App Structure

```text
ui/src/app/                 Next.js App Router pages and API routes
ui/src/components/          React components
ui/src/components/chat/     Chat UI and Dynamic Agents timeline
ui/src/components/dynamic-agents/
                            Agent, model, MCP server, and workflow management
ui/src/components/admin/    Admin and RBAC surfaces
ui/src/lib/                 BFF utilities, clients, auth, RBAC helpers
ui/src/store/               Zustand stores
ui/src/types/               Shared TypeScript types
```

## Current Chat Flow

The chat header shows the conversation title above the agent name. Long titles
and names truncate independently, with their full text available on hover.

The Agents list shows the execution harness logo beside each name. App-defined
agents use their app's logo instead; hovering identifies the app or harness.

The themed conversation picker below New Chat defaults to All chats and offers
Web chats, API chats, Autonomous runs, Scheduled runs, and Webhook runs in that
order, with icons and search. Automation choices appear when their platform
features are enabled. The selected view persists in browser storage; webhook
entries open each task's delivery timeline.

Collapsible agent and folder group names use 16px text; their chat counts remain
smaller secondary labels. Long names truncate with the full name on hover.

History rows use the Inline actions layout: 56px desktop rows, with title and
date/live status above the agent name and hover actions. Rows do not grow on hover.
The app/harness logo sits at the avatar's lower-right corner, offset outward to
keep the avatar glyph visible. Folder, rename, share, and
archive actions appear when that row is hovered or contains keyboard focus;
touch devices and an active rename keep them visible. Coarse pointers receive
larger touch targets on an additional action line. Scheduled and autonomous task
details appear in the avatar tooltip instead of a separate badge row.
Personal folders apply to regular chats, not run history.
The date uses the conversation's last update time, including messages and edits;
its tooltip shows the full local timestamp.

1. The user selects or opens a conversation in the UI.
2. The BFF validates auth/RBAC and forwards stream requests to Dynamic Agents.
3. Dynamic Agents streams AG-UI/SSE events back through the BFF.
4. The UI stores conversation messages and stream events in MongoDB-backed state.
5. MCP tools are reached through configured MCP server rows, usually via AgentGateway.

External app MCP clients can retain a saved root `api.mcp.path` URL after the app
moves behind `/apps/<id>`. The API fallback and protected-resource discovery
route delegate to the existing gateway and select the root OAuth resource with
`x-caipe-mcp-resource-path`. The app must support that fixed selector. See
[saved external MCP connections](../docs/docs/features/agentic-apps.md#preserve-saved-external-mcp-connections)
for OAuth resource registration and rollout requirements.

## Existing AgentCore agents

- **Agent Builder → Execution harness → Add existing AgentCore agent** is available to callers authorized
  to administer platform configuration. It registers an existing Harness or
  Runtime ARN as an immutable shared operator profile and selects that connection
  in the current Builder. Existing draft fields are preserved; save the agent to apply it.
- Assign instructions, ownership and access in the Builder. Registration does
  not copy AWS tools, permissions or history and does not provision AWS resources.
- Connection IDs start with `existing-`. The AWS Region must match the ARN.
  AWS invocation permission is checked when chatting using Engine credentials.
- See the [Harness Engine connection contract](../ai_platform_engineering/harness_engine/README.md#connect-an-existing-agentcore-deployment)
  for lifecycle and authorization details.

## Related Docs

- [UI overview](../docs/docs/ui/index.md)
- [UI configuration](../docs/docs/ui/configuration.md)
- [Dynamic Agents API](../docs/docs/api/dynamic-agents-mcp.md)
- [Helm chart reference](../docs/docs/installation/helm-charts/ai-platform-engineering/caipe-ui.md)

Native app chat panels may pass `showAgentHeader: false` when their own toolbar already identifies the assistant. The default is `true`, preserving the agent identity row in regular chat.

Native panels can supply `feedbackPrompt` (`message`, `actionLabel`, optional `trailingText`) to replace the default disclaimer with an inline action opening the existing host feedback form. This respects `reportProblemEnabled`; when reporting is disabled, the standard disclaimer remains. The audit logging notice is shown by default; native panels can use `showAuditNotice: false` to omit that footer text without changing audit logging.

Chat feedback offers an unchecked option to attach the latest question and response. It captures a snapshot when the form opens, limits each message to 6,000 characters with a truncation marker, and excludes tools and attachments. The reporter can edit the preview before submission; unchecking omits the excerpt from the request. Consent resets when the form closes.

### Browser chat authentication

First-party browser chat uses the same-origin session cookie for start, resume,
status and cancel. The BFF resolves the session's role and forwards its server-side
access token to the selected runtime. The browser does not attach a bearer token.

- Session-authenticated stream requests require `Origin` to match `NEXTAUTH_URL`
  (or the request origin when unset). An expired or missing session requires sign-in.
  The explicitly enabled non-production anonymous development provider retains its existing behavior.
- Explicit bearer credentials retain precedence, including when a cookie is also
  present. Invalid credentials never fall back to the cookie. API callers keep
  their bearer identity and do not inherit browser administrator privileges.
- Conversation-write, agent-use and app installation admission checks remain in
  force for every operation. Keep admin-only app policies unchanged.

## App feedback

Apps can opt into the existing report dialog through their deployment installation:

```yaml
agentic_apps:
  installations:
    - app_id: example
      package_id: example
      feedback_path: /api/example/feedback
```

`feedback_path` requires a runtime origin, including for feedback-only apps. It is a canonical path relative to that runtime. CAIPE selects
it from the current app page and forwards submissions through the existing app
proxy, including its availability, user access, POST policy and token checks.
The app backend owns the provider, repository/project/space, credentials and
attachments. It must derive reporter identity from its authenticated caller.
Return `{ "success": true, "data": { "id": "42", "url": "https://example.test/report/42", "provider": "github" } }`.
Supported receipt labels are `github`, `jira`, `gitlab` and `webex`; the URL may
be empty when the provider has no link.

The compatibility endpoint `/api/tickets/report` also accepts existing app
clients. Apps without `feedback_path` use the platform's existing configured
agent flow. A failed app submission is shown to the reporter and never silently
rerouted to that platform flow. No app SDK or provider dependency is added.
MCP provider registration and notification integration are tracked in #3151.

Clicking **thumbs down opens Provide Feedback directly** when
`REPORT_PROBLEM_ENABLED` is enabled, including installations whose app handles
reports without a global ticket provider. There is no intermediate reason dialog.
The form requires a short title and reproduction steps (Bug), or a goal
(Enhancement), and includes a Feature category, expected/actual results and an
optional related link. Closing it records nothing. Explicit submission records
the negative response feedback with the selected issue type and report details,
then creates the report. Closing and reopening a failed report reuses the pending or saved rating. The first successful rating retains its original details; each ticket attempt uses the current report details.
Requests include `title`, `issueType`, `feature`, labeled `sections` and
`relatedUrl`, plus a plain-text `description` for existing handlers. App forms
retain their own feature lists. The page URL retains its query parameters and
fragment, and chat excerpts remain opt-in. Positive ratings and installations
with reporting disabled retain the lightweight response-feedback dialog.

### Feedback feature categories

- Platform defaults cover Chat, Connected Credentials, Knowledge Bases, Skills,
  Workflows, Agents, MCP Servers, LLM Models, Schedules, Settings and Other.
- Set `FEEDBACK_FEATURES` to a JSON string array to replace the platform list:

  ```bash
  FEEDBACK_FEATURES='["Chat","Connected Credentials","Other"]'
  ```

- An app can publish `data.features` from GET on its registered `feedback_path`.
  Its embedded form can consume that same capability response. The host never
  substitutes platform areas for an app's features.
- A deployment can override the host form's app list in its installation:

  ```yaml
  agentic_apps:
    installations:
      - app_id: example
        package_id: example
        feedback_path: /api/example/feedback
        feedback_features: [Routing, Publishing, Other]
  ```

Lists contain 1–32 labels, each up to 40 characters. An app without a feature
list or capability GET offers Other. Category requests require feedback-submit
access and the app's launch policy. Reports from shared Chat also resolve the
canonical conversation's app binding after conversation-read authorization;
the category list and report destination use the same binding. The form blocks
submission while categories load, and offers a retry on discovery failure.

### Feedback components

- The shared feedback form selects **Component** before **Feature**. It displays the selected GitHub repository or Jira project returned by the host configuration; changing components updates that destination.
- The platform is first; `FEEDBACK_PLATFORM_LABEL` can override its component label
  independently of application branding. Installed, enabled apps with a registered `feedback_path`
  follow in registration order, filtered by the reporter's app access policy.
- Opening the form defaults to the current page/conversation's component. Changing
  Component preserves the report text, reloads features, and resets the feature
  choice before allowing submission.
- Component discovery uses authenticated `GET /api/tickets/report?view=components`;
  it does not contact every app's feedback service. Features load only for the
  selected component through its configured `feedback_features` or capability GET.
- Explicit requests use `componentId`: `null` for the platform, an installation app
  ID for an app. GET encodes platform selection as `componentId=`. Omitting it
  retains context-based routing for existing clients.
- Submission uses the selected registered handler. App launch policy, proxy
  authorization, and conversation read checks still apply. Provider failures do
  not reroute to another component.

### Platform feedback handler

Each app owns the provider, credentials and destination behind its registered
`feedback_path`. The platform component independently selects its default handler:

```dotenv
FEEDBACK_HANDLER=github
FEEDBACK_GITHUB_REPO=example/feedback
FEEDBACK_GITHUB_TOKEN=your-server-side-service-token
# Optional overrides:
FEEDBACK_GITHUB_LABEL=feedback
FEEDBACK_GITHUB_SCREENSHOTS_REPO=example/feedback-assets
```

- `github` creates an issue directly through GitHub's REST API and returns its
  receipt. It does not ask an agent to create the issue.
- Unconfigured platform destinations are omitted from the component picker. Requests are limited to 10 MiB before JSON parsing; an app capability GET may be undeclared, while explicit policy denials remain errors.
- `FEEDBACK_HANDLER=agent` retains Jira/GitHub agent reporting and requires an enabled provider and project/repository. Jira feedback categories are resolved against supported project issue types, rather than used as literal issue-type names.
- No handler is enabled by default. Missing handler, repository or dedicated
  credential returns 503. `agent` requires an explicit operator opt-in.
- Repository and token overrides are server-only. The handler uses only `FEEDBACK_GITHUB_REPO` and
  `FEEDBACK_GITHUB_TOKEN`; legacy provider settings are not fallbacks. Browser payloads cannot choose a repository or token.
- The issue includes the report text, type, feature, authenticated reporter,
  context URL and any explicitly included chat excerpt. Labels come from platform
  configuration and the selected issue type.
- GitHub failures are surfaced without retrying creation or invoking another
  component's handler. App reports still go exclusively to their app handler.
- Screenshots require an explicitly configured assets repository. The form hides
  capture/upload controls when the handler reports no screenshot support. An
  existing attachment must be removed before submitting to an unsupported handler.
- The service credential needs [Issues write permission](https://docs.github.com/en/rest/issues/issues#create-an-issue)
  on the feedback repo. Optional asset uploads also need
  [Contents write permission](https://docs.github.com/en/rest/repos/contents#create-or-update-file-contents)
  on the assets repo. No service token is returned to the browser.

### Host-managed app feedback

Configure `FEEDBACK_COMPONENTS_JSON` with installed app IDs mapped to `handler: "github"`, `repository`, `tokenEnv`, and `features`. Optional `screenshotsRepository` and `label` configure issue attachments and labels. The token environment key must match `FEEDBACK_*_TOKEN`; credential values stay in deployment secrets.

The canonical app loader applies these registrations to installed components, replacing any legacy app-owned `feedback_path` for that component. The shared `/api/tickets/report` API validates access, features, and authenticated reporter attribution, then creates the issue in the configured repository. Missing credentials fail closed. Apps need neither a feedback endpoint nor GitHub credentials. Other apps may still register their own `feedback_path`.

### Issue style and diagnostic context

- Platform: `FEEDBACK_GITHUB_STYLE_JSON` controls `titlePrefix`, base `labels`, `typeLabels`, `featureLabels`, and named `contextFields`.
- Installed components: set the same object under the handler's `style` in `FEEDBACK_COMPONENTS_JSON`. Browser-supplied labels, destinations, assignments and build values cannot override these rules.
- `titlePrefix: true` creates `[User Feedback][Component][Type]: Short title`. Unmapped features add no label. Impact stays in the body; priority and assignment remain triage decisions.
- The body includes the authenticated reporter, host version/commit, browser family/major version and OS, entry point, page/related URLs, impact and configured app context. Apps may supply project/page and their own version/commit through the host capability. App-supplied diagnostics are descriptive context, while host build metadata is read server-side.
- Configure labels that exist in the destination repository. The shared handler does not create or rename repository labels.
