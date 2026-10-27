# CAIPE App SDK

The **CAIPE App Contract** covers the shared application manifest and the
rendering-profile interfaces. The SDK supplies its types and conformance checks;
neither the contract nor its version checks provide a security sandbox.

Package `@caipe-io/app-sdk@2.0.0-rc.1` supports native component contract `2.0` and the shared
`AgenticAppManifest` API version `2.0`. Native `1.1` is explicitly retained
for compatibility; a legacy module is never silently relabeled as `2.0`.
The checker is intentionally
dependency-free at runtime and does not install or constrain a consumer's frameworks.
Native component types require the compatible host-provided React and Next.js
dependencies. The native application package, not this validation SDK, declares
the host framework peers checked by `caipe-native-check` and the final host build.
The current reference host uses Next.js `16.3.8` and React `19.2.8`; publishers
must run integration checks against each supported host release.

## Install and validate

After registry publication:

```bash
npm install --save-dev --save-exact @caipe-io/app-sdk@2.0.0-rc.1
npx caipe-app-check ./manifest.json
npx caipe-native-check ./unpacked-app-package
```

Framework-neutral consumers import types and validators from
`@caipe-io/app-sdk/manifest-contract`. Native component publishers import the
host interface types from `@caipe-io/app-sdk`.

## Native chat feedback

- Optional `chat.Panel.feedbackPrompt` supplies app-owned `message`, `actionLabel`, and optional `trailingText`. An empty message renders the link and trailing text alone.
- The host opens its existing feedback form and respects `reportProblemEnabled`. Without a prompt or when reporting is disabled, it renders the standard disclaimer.
- Optional `showAuditNotice` defaults to true. Setting it false hides the footer sentence without changing audit logging.
- **Include your chat** starts unchecked. Opting in displays an editable snapshot of the latest question and response, plus its chat reference. Each message is limited to 6,000 characters with a truncation marker; partial responses are labeled.
- Tool payloads and attachments are excluded. Unchecking omits the excerpt from the submission. Closing the form or switching conversations resets consent.
- These optional presentation properties preserve App Contract 2.0. Older hosts retain their previous footer.

## Release

- SDK versions are independent of host image and application package versions.
- This release candidate is not a stable release; the CAIPE App Contract's manifest and native component versions stay `2.0`.
- `publishConfig` defaults to public npm access and the `next` dist-tag.
- Maintainers must have publishing access to the npm `@caipe-io` scope.
- Check the packed artifact with `node --test ui/scripts/__tests__/app-sdk-package.test.mjs`
  from the repository root before publication.
- From `ui/app-sdk`, run `npm pack --dry-run`, then `npm publish --access public --tag next`.
- An authorized maintainer can bootstrap publication with `npm login`. Never commit tokens.
- For subsequent releases, configure npm trusted publishing with GitHub OIDC,
  a protected release environment, and provenance. Do not publish on PR events.
- Run native artifact and final host integration checks; schema validation alone
  is not a security certification or a runtime integration test.

Publishing the SDK does not enable runtime loading of native apps. Approved native
packages are still compiled into the CAIPE host image. Hosted apps can deploy
independently. Permission declarations do not grant access or provision agents.

Publisher CI can install a pinned SDK version or tarball from a supported CAIPE release
and run `caipe-native-check ./native-package` after compiling the app. Run the
same check against each host release the package claims to support. The CLI
checks manifest ownership syntax, client-only exports, shared peer runtimes,
client-component entry declarations, CSS document selectors, and bundle budgets. The CAIPE
host also checks cross-package route/API/slot collisions and lockfile integrity
when building the final image.

`caipe-app-check ./manifest.json` validates the shared declaration for native,
hosted, UI-only, and service-only apps. Types and pure validation functions are
available from `@caipe-io/app-sdk/manifest-contract`. Capability and
permission requests are declarations, not registration or grants. Runtime
origins and selected UI profiles belong to deployment-owned installations.

New native packages publish the full shared manifest and do not repeat their
policy in the runtime catalog. The generator derives a UI descriptor retaining
the native profile's declared component contract. See `docs/docs/features/agentic-app-manifest.md`
and `ui/examples/agentic-apps/shared/manifest.json` for the reference contract.
Both the publisher CLI and host generator read the `./manifest` export;
the JSON may be at the package root or in a compiled directory such as `dist/`.

An optional `assistant` claim (`agentId`, `label`, `name`) lets the host render
its own floating chat for a config-driven agent. The host fetches the agent
through its RBAC-protected API and sends bounded route context with turns. The
app must register its agent separately; Dynamic Agents assistants also configure
their tools separately. The native package does not receive credentials or create
agents at runtime.

An installed app may declare `ui.assistant.streamPath` as a safe `/api/`
path on its private runtime. Browser chat, the app assistant overlay and
linked-user bot conversations use the same host chat routes and conversation ID.
The host resolves the saved agent against installed app declarations; client
metadata cannot choose a backend origin or substitute an agent.

| Assistant declaration | Host operation | App response |
|---|---|---|
| `streamPath` | `/api/v1/chat/stream/start` | AG-UI SSE |
| `resumePath` (optional) | `/api/v1/chat/stream/resume` | AG-UI SSE |
| `cancelPath` (optional) | `/api/v1/chat/stream/cancel` | JSON with `cancelled: boolean` |

Use the host's default `agui` chat protocol for app streams. Each path must have an
allowed POST policy; resume/cancel declarations require `streamPath`. The host
forwards the existing operation body unchanged, including the authorized
conversation ID and untrusted client context. Apps implement their own runtime,
session mapping, deadlines, source access and optional verification controls.
Keep runtime origins and private services server-side.

Agent-use and conversation-write checks run first. The same resolved user then
passes through the app gateway's launch and HTTP policy checks and configured
token mode. Service accounts cannot substitute for an interactive user.
Declaring a stream grants no access. A conflicting/unavailable app configuration,
a denial, or an upstream failure does not invoke a different agent runtime.

### Webex native streams

`ui.assistant.supportedClients` defaults to `["webui"]`. Apps explicitly enable
Webex with `["webui", "webex"]`. `webexGroupChat: true` is a separate opt-in for
apps that enforce group-safe data access; absent/false rejects group spaces.
The publication checkers retain and validate both capabilities. Catalog discovery
uses the verified OAuth client identity to omit unsupported app assistants.

- The Webex bot continues using its linked human OBO token. The host validates
  the signature-verified `azp` against `KEYCLOAK_WEBEX_BOT_CLIENT_ID`.
- Configure the same `WEBEX_LINK_HMAC_SECRET` (at least 32 bytes) on bot and host.
  The bot signs the exact POST bytes, bearer-token hash, room, space, thread,
  conversation, agent and timestamp after the existing event/room/identity gates.
  Public `client_context` or `X-Client-Source` alone never grants this authority.
- The host checks the proof against the stored thread and authenticated request,
  after the existing agent-use and conversation-write gates. It then applies the
  app's ordinary role, HTTP-action and token policies without admin elevation.
- The private runtime receives `X-CAIPE-Assistant-Context`: an app-audience JWT
  signed with the existing `AGENTIC_APP_TOKEN_SECRET`, valid for 60 seconds. It
  has `purpose: "assistant-stream"` and `assistant_context` containing `client`,
  `kind`, `conversationId`, `agentId`, `roomId`, `spaceId`, `threadId`, `method`,
  target `path`, exact `bodyHash` and upstream bearer `tokenHash` (SHA-256 hex).
- Apps verify issuer, audience, signature, expiry, purpose, caller subject, body,
  path and stored conversation/room bindings before accepting Webex. Then they
  enforce their own project/tool permissions and room-data policy. Client type
  stays `webex`. Service-account credentials cannot stand in for the human.
- The proxy strips caller-supplied `X-CAIPE-*` headers before adding its own proof.
  Missing/expired/mismatched proofs and unsupported clients fail closed, without
  falling back to Dynamic Agents. Bot output limits and existing AG-UI rendering
  remain in force. Disconnect/cancellation continues through the existing stream.

Keep the legacy agent and thread route until the app has adopted this contract.
Changing the default route affects new threads; migrating existing threads must
also update the stored agent participant and `thread_owner_agent_id`, preserve
messages and access controls, and clear the bot's thread-owner cache. Provider
checkpoints are runtime-specific and must not be copied to the native runtime;
the app should load authorized recent transcript context for a fresh session.

A missing resume/cancel capability returns `501`; it never resumes or cancels a
Dynamic Agents run. Without an app stream claim, existing Dynamic Agents behavior
continues. Start/resume permit up to 16 minutes at the host boundary; applications
must enforce their own bounded deadline, emit SSE heartbeats and honor aborts.
The host preserves AG-UI events and cancellation acknowledgements. It does not
implement SDK-specific sessions, automatic retries or durable stream replay.

The `2.0` release retains the existing component props and trust model; the
aligned numbering is not a new rendering engine, sandbox, or permission grant.
New packages must declare `2.0` in both their native profile and module export.
The host rejects mismatches and unknown versions before mounting a component.
The browser-safe `./contract-version` export exposes the supported versions.
A breaking interface change requires a new contract version and a matching
SDK major version. App package versions remain independently versioned.

### Installed assistant identity

A deployment may bind `installations[].bindings.resources.assistant` to its
registered agent ID. This replaces the manifest assistant's logical `agentId`
for discovery and stream routing. It does not change stream paths, authorization
policies, or the pinned publisher artifact. The app must declare `ui.assistant`.

Native packages that render their own assistant UI declare
`ui.assistant.overlay: "app"`. The host skips its default launcher while retaining
assistant discovery and stream routing. Omitting this field retains the host UI.

### Host-owned native chat sessions

Declare required `host.chat@1.0` and render `props.chat.Panel` with the saved
conversation ID and deployment-bound agent ID. The host owns the request, shared
chat store, persistence, stop action and green live-response bar. Removing the
native screen does not abort its turn. Native packages should not render their
bundled chat consumer alongside this panel.

Hosts may also expose `props.chat.ConversationActions`. Feature-detect this
optional component in each history row and pass that row's conversation/agent IDs
and `onArchived` (refresh history; select or create another chat only when the
archived chat was active). It reuses GRID's share control and recoverable archive
API without adding an archive browser. Only owners see share/archive actions;
all mutations still use host conversation authorization.
Apps must not add a second sharing or archive implementation.

Apps may supply a composer header and bounded per-question `requestOptions`; these
are forwarded as `forwarded_props` and must be validated by the app. Agent binding
and authorization remain server-owned.

For another tab to observe an active response, declare `ui.assistant.statusPath`.
It is an authenticated POST accepting `conversation_id` and `agent_id`, returning
`{running: boolean, turnId?: string}`. Return only the caller's current turn; never
include SDK IDs, credentials or retained model context. Status uses the same app
gateway and conversation-write/agent-use authorization boundary as start.

The host polls active status and authorized saved messages, with a bounded watch
and a short final-save grace period. It never resubmits the question. Apps that
omit status keep their existing behavior. This capability does not promise durable
SSE replay after the browser owning the request closes.

### Assistant routing snapshot

Startup validates the deployment catalog and records its assistant bindings. Routing
uses that last successfully validated snapshot for the same catalog path. A failed
catalog read does not send app-owned chats to Dynamic Agents or block unclaimed
agents. App proxy calls still validate the live catalog and fail closed when it
is unavailable. Successful `loadConfiguredAgenticApps()` calls explicitly refresh
the snapshot; a UI restart revalidates it before serving traffic.

## App identity in agent catalogs

- `catalog.icon` names a same-origin asset: `/app-icons/<app-id>/<filename>`.
  Supported extensions: `svg`, `png`, `webp`, `jpg`, `jpeg`. URLs, query strings,
  encoded paths and traversal are rejected. Legacy symbolic icon names remain valid
  and use the generic app icon.
- Native publishers include the asset at `public/app-icons/<app-id>/<filename>`
  in the pinned npm package. The host copies the declared file during generation;
  missing files, symlinks outside the package and images over 256 KiB fail the build.
  Hosted installations may provision the same public asset namespace on the host.
  Logos are public, reviewed assets; never put private content in this directory.
- Authorized agent responses include read-only `presentation: { app: { id, name,
  icon? }, available }`. The BFF derives it from the resolved
  `bindings.resources.assistant` identity. Stored or submitted presentation fields
  are ignored. Runtime origins and stream paths are not exposed in this projection.
- App agents use their packaged app logo with an `App: Example App` tooltip.
  Missing, invalid, or broken logos fall back to a filled app tile with a large
  cutout spark. The hub heading and generic app fallbacks use this same mark.
  Catalog cards also display packaged app branding. The Apps sidebar destination
  retains the nine-dot launcher; legacy `layout-grid` navigation keeps its grid icon.
  The app's internal SDK is not inferred from an absent `execution_harness_id`.
  Legacy platform agents keep their existing Deep Agents fallback.
- Agent CAS permissions still apply. App role/launch policy further restricts the
  chat catalog; an app stream also requires an interactive user. Disabled or
  uninstalled apps are excluded from new-chat choices, while authorized details
  retain app identity with `available: false`. Duplicate assistant claims fail
  closed. Presentation never selects a runtime or grants access.

## Native conversation controls

- `chat.ConversationActions` is optional. Feature-detect it before rendering history actions.
- Pass `conversationId`, `agentId`, `onArchived`, and optional `disabled`. The host renders Share and Archive for owners using its existing dialogs and store.
- The host checks app launch access, agent availability and conversation binding before restoring the panel or its actions. Server authorization still applies to every mutation.
- Closing a native view restores the previous selection while the host retains the stream. Native packages do not own another chat store.
- Hosts without `ConversationActions` continue to support `chat.Panel`; older native packages need no changes.

## Assistant overlay ownership

`ui.assistant.overlay` defaults to `host`. Set it to `app` when the app owns
its launcher and popup. Native and iframe renderers both honor this declaration.
App ownership suppresses only the host popup; assistant registration, agent-use
authorization and app-defined stream routing remain available.

## Application sidebar contributions

`ui.navigation` contributes one authorized entry after Chat in expanded and
collapsed navigation. Disabled, hidden, uninstalled and unauthorized apps are
omitted. Installation `navigation_overrides` supports `visible`, `label` and
numeric `order`; overrides cannot move a link outside the app's entry route.
Native and iframe profiles share the catalog, preventing duplicate entries.
Canonical `/apps/<id>` entries use document navigation through the existing
unsaved-change guard; compiled native host paths keep client navigation.

## Iframe host routes and bridge

Publishers declare `ui.routes`; operators explicitly approve iframe takeover
using installation `host_route_claims`:

```yaml
- app_id: example-app
  installed: true
  enabled: true
  selected_ui_profile: hosted
  host_route_claims: [/projects]
  bindings:
    runtimeOrigin: http://example-app.example.svc:3000
```

- The declared `/projects` subtree renders inside the host shell while its public
  path, query and fragment stay in the address bar. The iframe continues loading
  through `/apps/example-app/projects/...`; private origins stay server-side.
- Canonical `/apps/<id>` links resolve to approved public routes without loops.
- Reserved routes and conflicting active owners fail closed. Disabling an app
  or removing its claims restores host routing. Profile changes require reload.
- Host route admission and the existing app gateway both enforce app access.
- `@caipe-io/app-sdk/iframe-bridge` supplies `createAgenticAppBridge`. Its existing
  context/open protocol gains a capability handshake and owned-route navigation.
  The host validates source, origin, app ID and version before handling messages.
- Apps use `bridge.navigate(href)` for host URL synchronization and dispose the
  bridge on unmount. Unsupported versions/capabilities report explicit errors.
- Same-origin iframe hosting is a trust boundary, not JavaScript isolation.

## Shared host assistant

- The iframe bridge accepts the host's boolean
  `caipe.microfrontend.initialize.v1.context.preferences.shadows_enabled`
  presentation preference after checking origin, parent window, version and app
  ID. It removes decorative box/text shadows while preserving focus rings.
  Missing preferences leave the app's appearance unchanged. Native apps inherit
  the host setting directly.

- Iframes can publish the same host breadcrumb row as native packages when
  `bridge.getCapabilities()?.breadcrumbs` is true. Call
  `bridge.setBreadcrumbs([{ label: "Home", href: "/" }, { label: "Example" }], "/example")`
  with the current public route. Hide the app's duplicate row only after the
  host advertises support. Labels are plain text; links must belong to the app,
  except for the initial host Home link.
- Keep one bridge for the lifetime of the app document. Publish page/query
  changes independently of assistant context or visibility. The host preserves
  a connected frame through owned SPA routes; apps without the bridge retain
  document-navigation fallback. Host Back/Forward updates the child URL rather
  than replacing its iframe document. `navigate(href, { history: "replace" })`
  supports query edits without adding history entries.

Native and iframe apps with `ui.assistant.overlay: "host"` use the same branded host popup,
resize behavior, context handling and chat panel. Native packages request it
through the optional `props.chat.assistant` capability;
iframe apps use `bridge.openAssistant(context)` after the capability handshake.
Native packages must guard this capability before calling `open` or `setContext`:

```ts
const assistant = props.chat?.assistant;
if (assistant) {
  assistant.open(context);
}
```

The host omits the capability in home slots, when the app has no `ui.assistant`,
or when it declares `ui.assistant.overlay: "app"`. `assistant.setContext(context)`
updates context without opening the popup.
App-owned overlays remain supported explicitly. Context passes the existing
size/secret filters and stays untrusted data, never an authorization grant.
The native wrapper resolves the installation's bound agent and agent-use policy
before mounting the popup; chat dependencies load lazily. Account, subject,
organization and role changes reset the assistant binding.

## Shared assistant history and conversation controls

- Native and iframe assistants use the same compact conversation title,
  inline rename dialog, Chat/History tabs, actions menu, open-in-chat link,
  and minimize button. The full-page link opens the same conversation in a
  new tab; it does not create or copy a chat.
- New chat, expand, reset size, recoverable clear, text size, glass mode,
  and current-page context controls are in the actions menu. Light and dark
  appearance follow the host theme. Text size and glass preferences persist.
- Chat stays mounted while History is visible, preserving the draft and live
  stream. Closing the popup retains the host conversation and stream lifecycle.
- History shows conversation dates and selected state, loads older pages on
  demand, and provides loading, retry, and empty states. A page containing only
  unrelated chats still offers Load more when older history exists.
- The popup and full-page chat reuse the same chat panel for messages, tool
  timelines, citations, attachments, queued turns, stop/retry, editing, feedback,
  and authorized agent model/skills controls. App-specific source choices and
  presentation text remain declarative options rather than a separate renderer.
- Opening full-page chat carries over the app's validated runtime source choices
  across tabs for up to five minutes, scoped to account, organization, role,
  app, and agent. Updates from an open app refresh those choices. When required
  configuration is unavailable or expires, controls stay hidden and the backend
  chooses its default. This presentation cache never grants access; conversation,
  app, agent, and request-option checks still run at the server boundary.
- The host popup provides Chat/History views with the existing rename, share and
  recoverable archive controls on each history item. No archive browser is added.
- History selection revalidates the installation, bound agent and conversation.
- Open a history row's actions to validate and load its rename/share/archive controls.
- History and deep links require an explicit app/agent conversation binding;
  unrelated or unbound same-agent chats are not implicitly adopted.
- `?assistant_chat=<conversation-id>` restores that exact authorized conversation;
  invalid links report an error instead of silently creating another chat.
- Changing the link on the current page revalidates the new chat and hides the
  previous chat while loading. Local history restores and renames through the
  browser store; sharing controls require MongoDB storage.
- Context suggestions fill the composer; the user explicitly sends the message.
- Host-owned popups support validated context and suggestions. App-specific source
  selectors remain available through native `chat.Panel` composer composition.
  Unsupported iframe composer extensions are rejected explicitly. Apps requiring
  their own controls can retain `overlay: "app"`.

### Shared assistant configuration

Declare `ui.assistant.overlay: "host"` to use CAIPE's popup. Optional
`ui.assistant.hostOptions` is a validated `AssistantOptions` declaration:

```json
{
  "version": "1.0",
  "requireConfiguration": true,
  "includeLegacyAgentHistory": true,
  "legacyConversationQueryParams": ["example_chat"],
  "controls": [{
    "id": "sources", "label": "Search sources", "requestKey": "verify_sources",
    "defaultChoice": "local",
    "choices": [{"id": "local", "label": "Local only", "value": false},
                {"id": "verify", "label": "Verify sources", "value": true}]
  }]
}
```

- Native: check `chat.assistant.extensions`, then call `configure`,
  `setContext`, `open`, `close`, and optionally `subscribe` to synchronize app buttons.
- Iframe: use `createAgenticAppBridge` from `@caipe-io/app-sdk/iframe-bridge`.
  Wait for capabilities; use `configureAssistant`, `setContext`, `openAssistant`,
  `closeAssistant`, and `onAssistantState`. Call `dispose` on unmount.
- `configuration.v1`, `choices.v1`, and `presentation.v1` advertise support.
  Missing capabilities must produce an explicit unavailable state; do not render
  a second popup as an embedded fallback.
- Runtime configuration supplies `{version: "1.0", visible: boolean}` and may
  narrow declared controls with `{choices: [id], defaultChoice: id}`. With
  `requireConfiguration`, the launcher stays hidden until configuration arrives.
  Hide it during settings loading/failure and release visibility on app unmount.
- `presentation` declares placeholder, feedback wording, audit-notice visibility,
  font scale, and bounded default width/height. Users can change text size,
  expand and reset size through the common display menu. Audit presentation
  does not disable logging. One remaining choice applies without a selector.
- Choice values are scalar, publisher-declared `forwarded_props` entries.
  Runtime messages cannot add keys/values. Routing, identity, authorization and
  other protected keys are rejected; the BFF revalidates choices for app streams.
  App backends must still validate settings and enforce resource permissions.
- Legacy history is an explicit opt-in for the installation-bound agent.
  Personal history contains owned chats only; every selection refreshes access.
  Explicit shared links retain existing conversation permissions. App metadata
  never grants access; conversations marked for another app are rejected.
- Declared query aliases resolve exact chats and become `assistant_chat` only
  after successful restoration. Invalid/conflicting/denied links show errors.
  Chat query parameters stay outside the iframe URL to avoid reloading the app.
- Account changes remount the controllers. Context is untrusted data; iframe
  messages validate source/origin/app/version and never carry host credentials.
  Browser authentication consistency for restricted apps is tracked separately
  by the session-stream authentication fix.
- Standalone apps can retain their own assistant when no host exists. Keep it
  outside native bundles; host-owned embedded apps use the host renderer/store.

### Open the assistant with a question draft

- Wait for both `getCapabilities()?.assistant` and `getCapabilities()?.assistantDraft`
  before calling `bridge.openAssistant(context, { id: crypto.randomUUID(), text: question })`.
  Draft support may be advertised while the assistant agent is still loading.
- The host validates the iframe source and origin, shows Chat, waits for its
  conversation and enabled composer, appends the question to existing text, and
  focuses it. It never submits the question.
- IDs contain 1–128 ASCII letters, digits, `_` or `-`. Text is plain text with a
  12,000-character limit. The SDK reports invalid or unsupported drafts before opening;
  the host ignores invalid drafts.
- Existing `openAssistant(context)` calls remain compatible. The wire format is
  the optional `draft: { id, text }` field on `caipe.agenticApp.assistant.open.v1`.
