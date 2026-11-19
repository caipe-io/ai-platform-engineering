# Presentation MCP

One optional container provides shared PowerPoint tools and a template/download
page. Agents supply reviewed slide JSON and source URLs from any authorized
source; no project, knowledge application or model runtime is required here.

## Tools and workflow

1. `presentations_list_templates` returns the caller's available template IDs,
   content/profile versions and modes. Template bytes never enter model context.
2. `presentations_plan` validates a deck and returns its actual slide count after
   density splits. Include explicit cover, content, open-items and closing slides
   when the selected template's contract requires them. Show this plan for approval.
3. `presentations_render` requires `approved: true`, the same template version and
   reviewed deck. It returns a private download URL, expiry, count and review warnings.

`approved` records the agent's assertion, not a cryptographic human approval.
Agents must obtain the user's approval before calling. Sources are links provided
by the agent; the renderer does not retrieve evidence or verify claims. Mark
unsupported wording `verify: true`; review flags stay in speaker notes, with no generated Verify badges or prefixes on slides. Text, structured visual groups, source links and full notes remain editable. Font files are not embedded. Automatic visual QA, charts and images are
not implemented; review the generated file before presenting.

A deck contains `title`, `mode`, `density` and `slides`. A slide has `kind`
(`cover`, `content`, `open_items`, `closing`), `title`, optional `subtitle`, `role`,
`status`, `notes`, `bullets` and `items`. Bullets contain `text`, `sources` (HTTP/S
URLs), and `verify`. Open items contain `text`, optional `owner` and `due`; missing
owners/dates read `To assign`. The MCP schemas are the complete input contract.
There is no implicit addition of bookends or approval status.

Content slides can supply `visual` instead of `bullets`. Choose `layout` from
`metrics`, `comparison`, `flow`, `timeline`, `layers` or `ledger`, and supply 2–5
`groups` with `label`, optional `value`, concise `items`, `sources` and `verify`.
Metrics and comparisons accept 2–3 groups; metrics require explicit values.
Ordered flow/timeline/layer groups define the sequence; no relationships are
inferred from prose. All labels and connectors are native editable objects that
use the uploaded template’s canvas, theme colors and fonts. No image service or
knowledge application is required.

The planner returns each physical slide’s composition and rejects visuals that
exceed the selected density or canvas. It preserves groups together rather than
splitting a diagram across pages. Shorten visual labels and keep explanation in
notes; never invent metrics or dates. Text-only decks remain supported, and split
slides now show part numbers. New agent executions must discover the updated MCP
schemas to request visual groups; existing downloads are not rewritten.


## Deploy in an existing CAIPE instance

- Build this directory's Dockerfile or use the reviewed `mcp-presentations` image.
  The focused CI workflow publishes same-repository `prebuild/` PR images to GHCR.
- Install the optional `charts/mcp-presentations` chart with a pinned image digest.
- Register `deploy/app.json` as an iframe application with a runtime origin pointing
  to the service. Keep `auth.mode: forward-user-access-token` and the declared method
  policies. Bind the hosted profile and show it in the app hub.
- Register a separate HTTP MCP target to `http://<service>:8088/mcp` through
  AgentGateway. Resolve the signed-in caller's token via `caller_token`; the gateway
  must preserve the user bearer for the upstream service. Grant the intended teams
  access to the MCP server and attach the three tools to the desired agents.
- For browser and first-party MCP use, configure the trusted login client to issue
  the exact presentation resource audience. Tokens also need the host API audience
  because the service calls its authenticated membership API. Manage the audiences
  declaratively; enabling anonymous DCR alone does not supply them. Dedicated
  single-audience external OAuth clients are not supported by this initial adapter.
- Configure `PRESENTATION_DOWNLOAD_URL` to the host's authenticated runtime base
  (`https://example.test/api/agentic-apps/runtime/presentations`). This returns a
  binary download directly instead of opening another iframe shell.
- Open the app with the normal host login, upload the empty template using its
  operator-configured preset and owner team, then use a fresh agent chat with the
  tools selected. A skill alone does not install these tools.

The service verifies JWT signature, issuer, audience, subject and expiry. It calls
`CAIPE_API_ORIGIN/api/dynamic-agents/teams` on each request, with the validated bearer,
using the host's canonical membership adapter. Untrusted identity headers and JWT
team hints cannot grant access. Authorization failures/outages fail closed.
Team admins can upload/replace their team's templates; members of the owner or
shared teams can render. Generated downloads additionally require the rendering
subject and current template access. New decks expire after seven days. **Keep**
removes the expiry date so MongoDB’s TTL index leaves that file intact. **Kept**
turns auto-delete back on with a fresh seven-day countdown. Repeating that request
does not extend an existing countdown. Expired files cannot be kept or downloaded,
even while asynchronous TTL cleanup is pending.

**Delete** permanently removes the creator’s stored deck after an in-app
confirmation; its download link stops working. Only the creator can keep, resume
expiry or delete a deck, including when template access has been removed. Keeping
a deck never bypasses current template access for downloads. Templates themselves
persist. Sharing a chat does not share its files.

## Configuration

| Variable | Meaning |
|---|---|
| `MONGODB_URI`, `MONGODB_DATABASE` | Private storage; use a dedicated database user |
| `OIDC_ISSUER`, `OIDC_JWKS_URL` | Trusted signing authority |
| `PRESENTATION_TOKEN_AUDIENCE` | Exact service resource audience |
| `CAIPE_API_ORIGIN` | Operator-controlled host API origin; never user input |
| `PRESENTATION_PUBLIC_URL` | Hosted app URL, e.g. `https://example.test/apps/presentations` |
| `PRESENTATION_DOWNLOAD_URL` | Same-origin authenticated binary download base; defaults to public URL |
| `PRESENTATION_PROFILES_FILE` | JSON file of operator-owned template presets |
| `PRESENTATION_DEFAULT_PROFILE_ID` | Optional preset preselected in the upload form; must exist in the configured presets |
| `PRESENTATION_DEFAULT_TEMPLATE_ID` | Optional UUID marked `is_default` in authorized template lists; an explicit user selection takes precedence |
| `PORT`, `HOST` | Defaults to `8088`, `0.0.0.0` |

Defaults are deployment configuration, with no bundled brand or template. Upload a
template first, then configure its ID as the default. This preference never grants
access: callers outside its teams do not see it. Agents must still list templates
and use the current version before planning or rendering.

Presets are `{id, name, profile}` entries. A profile supplies named modes mapping
one-based master/layout numbers for `cover`, `content`, `closing`, optional
`open_items`; placeholder indices; a content canvas `[x, y, width, height]` in
inches; source-line `footer_y`; and font family. Upload validation checks these
against the template's actual master/layout relationships and page dimensions.
Keep proprietary presets, templates and fonts in deployment-owned private storage,
not generic source or images. The upload UI uses the configured default preset automatically, or the sole
preset when only one exists. With multiple presets and no default, an operator
must configure a default before browser uploads can succeed. Existing API clients
can still pass `profile_id` explicitly. Users select only the file, owner team and
optional sharing teams.

The standalone iframe has no host React runtime, so its small DOM picker adapter
follows the host `SearchablePicker` contract instead of importing React/Radix.
It uses bounded top-layer listboxes inside the upload dialog, keyboard navigation,
case-insensitive name/slug search, exact-match ranking, selected-team chips and
explicit empty/result-count states. Owner choices are admin-only; sharing excludes
the owner and supports up to 30 accessible teams. Native datalists are not used.

The Mongo user needs read/insert/update on `presentation_templates` and
read/insert/update/remove/createIndex on `presentation_artifacts`, plus database ping.
Templates are capped at 8 MiB and outputs at 12 MiB. The parser limits ZIP expansion
and entries, rejects sample slides, macros, embedded objects, remote embedded
content and XML entities. Two bounded worker threads permit 192 MiB heap and
30 seconds each; excess work receives a retriable busy response. The service
never executes slide text or fetches user-supplied source URLs.

## Validation

```sh
npm ci --ignore-scripts
npm test
PRESENTATION_TEST_MONGO=1 npm test
```

Mongo integration tests connect only to `127.0.0.1:27018`, create randomly named
`presentation_test_*` databases and delete only those fixture databases afterward.
They exercise actual HTTP, signed JWT validation, MCP client discovery/calls,
render workers, stored binary output and ownership/revocation denial. Their host
membership responses are fixtures; this is local integration evidence, not live
CAIPE authorization or browser acceptance.

For private-template QA, set `PRESENTATION_TEST_TEMPLATE` to an external empty PPTX
and `PRESENTATION_TEST_PROFILE` to its external preset JSON. Optionally set
`PRESENTATION_TEST_OUTPUT_DIR` to inspect the generated files. These binaries and
presets are intentionally absent from source and normal CI. Render and inspect
all slides with the template's fonts; a successful package test is not visual QA.

CI generates complete synthetic packages for all three densities and validates
them with Microsoft's pinned Open XML SDK checker in `test/openxml`. Notes retain
the selected master's color map and a separate copy of its theme: sharing the
slide theme with the notes master can pass schema validation but trigger a
PowerPoint repair prompt. Configured-host acceptance must also open the exported
file in PowerPoint without repair; a LibreOffice render alone is insufficient.

Acceptance cases: MCP-06.01–03, with MCP-05, SEC-04 and APP-05 at the configured host
boundary. No enabled deployment or live model workflow is implied by unit tests.
