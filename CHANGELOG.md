## 1.0.0-dev.24 (2026-09-04)

### Fix

- **autonomous-agents**: address code quality review
- **docs**: version historical internal links (#2641)

## 1.0.0 (2026-09-03)

## 1.0.0-dev.23 (2026-09-03)

### Feat

- add timezone support and userhub metadata
- **agentic-apps**: add Weather reference runtime
- **ui**: add config-driven hosted application runtime

## 1.0.0-dev.22 (2026-09-02)

## 1.0.0-rc.7 (2026-09-02)

## 1.0.0-dev.21 (2026-09-02)

### Fix

- **rbac**: allow self-service read access to Webex bot picker

## 1.0.0-dev.20 (2026-09-02)

### Feat

- **ui**: add re-upload modal for file datasources
- **rag**: add file datasource re-upload endpoint

### Fix

- **rag**: preserve job history across file datasource re-uploads

## 1.0.0-dev.19 (2026-09-02)

### Feat

- **scheduler**: min interval restriction

### Fix

- **ci**: use built-in token for Dependabot Grype scans (#2628)
- Update README.md (#2542)

## 1.0.0-dev.18 (2026-09-01)

## 1.0.0-rc.6 (2026-09-01)

## 1.0.0-dev.17 (2026-09-01)

### Feat

- **ui**: add an API section to Insights Statistics
- **ui**: add a Webex section to Insights Statistics, mirroring Slack

### Fix

- **ui**: force client_type to 'api' for non-first-party Bearer callers
- **audit**: attach real identity to bridge authz-decision audit events
- **webex**: stop agent-flash on pinned threads; exclude DMs from Top Spaces
- **ui**: exclude Webex conversations from the default sidebar listing
- **ui**: stop the picker chevron from shifting when a value is cleared
- **ui**: stop wide line charts from stretching data points and text
- **audit**: capture openfga_rebac events at standard verbosity
- **audit**: return a clean error instead of a bare 500 on retention failures
- **webex**: redirect to sign-in instead of a bare 401 on webex-link/start
- **ui**: fix chart hover misalignment on wide line charts
- **ui**: make DAU/MAU "Today"/"This Month" cards rolling windows
- **ui**: show a Webex source option in the Insights stats picker
- **webex**: tag Webex message turns with source "webex" for Insights
- **ui**: clear the ?request= param after approving/rejecting it
- **ui**: paginate the Default agents picker's accessible-agents fetch
- **webex**: pin threads to their first-responding agent

### Perf

- **audit**: parallelize S3 list/fetch calls in the audit-service read path

## 1.0.0-dev.16 (2026-09-01)

## 1.0.0-rc.5 (2026-09-01)

## 1.0.0-dev.15 (2026-09-01)

## 1.0.0-dev.14 (2026-08-31)

### Feat

- **ui**: add owner team editor to Webex configured space detail
- **ui**: add Webex Advanced admin tab and harden Slack/Webex parity
- **ui**: unify Webex/Slack DM default-agent settings
- **rag**: show collection id in the collections detail pane
- **rag**: filter search MCP tool by collection_id

### Fix

- **ui**: skip unused runtime-status fetch, filter malformed direct-user rows
- **webex-bot**: silence linked users on disabled DMs, recognize legacy reply marker
- **ui**: fix stale-response race and double-fetch in Webex 1:1 panel
- **rbac**: revoke stale team grant and avoid duplicate Webex space mapping
- **webex-bot**: stop nesting bold and italic in agent-reply footer
- **rbac**: require bot_id on Webex team-space assignments
- **ui**: use public origin for Webex link callback redirect

### Perf

- **ui**: paginate and search the 1:1 Messages admin tab

## 1.0.0-dev.13 (2026-08-28)

## 1.0.0-rc.4 (2026-08-28)

## 1.0.0-dev.12 (2026-08-28)

### Refactor

- **ui**: remove Webex legacy migration tab and backend

## 1.0.0-dev.11 (2026-08-27)

### Feat

- **charts**: wire self-service Webex identity-linking vars into caipe-ui chart

### Fix

- **ui**: revert prior Webex fix, correct e2e tests to match intended tab order
- **ui**: restore Webex onboard default tab and listen-mode diagnostic fix
- **integrations**: remove insecure Slack HMAC identity-link mechanism
- **ui**: align accent theming and navigation state (#2605)

### Refactor

- **ui**: standardize reusable selection controls (#2597)

## 1.0.0-dev.10 (2026-08-27)

## 1.0.0-rc.3 (2026-08-27)

## 1.0.0-dev.9 (2026-08-26)

### Fix

- **platform**: align RAG access and application controls (#2599)

## 1.0.0-dev.8 (2026-08-26)

## 1.0.0-rc.2 (2026-08-26)

## 1.0.0-dev.7 (2026-08-26)

### Feat

- **ui**: add global command palette (#2463)
- **autonomous**: remove redundent max retires and timeout
- **autonomous**: webhook to be in a single chat with each run having "continue this run" button to chat on that particular run

### Fix

- **ui**: show deployed version in about, refresh homepage, and consolidate release docs (#2595)
- **ui**: hide API-created conversations from chat history (#2588)
- **ui**: test

## 1.0.0-dev.6 (2026-08-26)

### Feat

- **ui**: add global platform health notifications (#2416)

## 1.0.0-dev.5 (2026-08-25)

### Feat

- **ui**: restore feature-gated feedback shortcut (#2435)
- **ui**: add agent completion browser alerts (#2413)

### Fix

- **ui**: redirect personal insights to filtered admin statistics (#2586)
- **ui**: align new chat agent resolution (#2464)
- **ui**: support legacy conversation identifiers (#2466)

## 1.0.0-dev.4 (2026-08-25)

### Feat

- **ui**: improve global navigation and breadcrumbs (#2407)
- **ui**: standardize searchable agent pickers (#2403)

## 1.0.0-dev.3 (2026-08-25)

## 1.0.0-dev.2 (2026-08-25)

### Feat

- **ui**: customizable Home page with Quick Start and optional widgets (#2408)

### Fix

- update README.md (#2472)
- **ci**: remove unused Helm publish app token (#2399)

### Refactor

- **ui**: retire legacy agent builder (#2443)

## 1.0.0-dev.1 (2026-08-24)

## 1.0.0-rc.1 (2026-08-24)

### Fix

- **docs**: replace restricted star history embed (#2471)
- **ci**: support RC versions in manual releases

## 0.6.0-dev.8 (2026-08-24)

### Fix

- **ci**: restore RBAC and Playwright checks

## 0.6.0-dev.7 (2026-08-24)

## 0.6.0-dev.6 (2026-08-24)

## 0.6.0-dev.4 (2026-08-24)

## 0.6.0-dev.2 (2026-08-24)

## 0.6.0-dev.1 (2026-08-24)

### Feat

- **webex**: add self-service Webex identity linking in settings

### Fix

- **webex**: disable Relink button while an unlink request is in flight
- **webex**: fall back to raw id in admin panel when no email captured
- **auth**: enforce max age on signed OAuth state cookies
- **webex**: close check-then-write race on identity link claim
- **webex**: resolve false revision-conflict on publication approval
- **webex**: show linked account email instead of raw id in admin panel

## 0.6.0 (2026-08-21)

## 0.5.69-dev.4 (2026-08-20)

### Fix

- **security**: resolve dependency vulnerabilities (#2415)

### Refactor

- **dynamic-agents**: use immutable prompt rendering (#2369)

## 0.5.69-dev.2 (2026-08-20)

### Feat

- **docs**: up to date autonomous agent docs

### Fix

- **autonomous**: webhook secret ffs

## 0.5.69-dev.1 (2026-08-19)

### Feat

- **autonomous**: add min run interval (configurable) and wehook should NOT appear in the chat
- **ui**: autonomous and schedule chats in separate sections to history

### Fix

- **skills**: repair zip import ownership and file access
- **autonomous**: add webhook limits and address security concerns
- **autonomous**: better admin tab and remove task oversight
- **autonomous**: secret should be secretly handled
- **ui**: autonomous page scroll issue

## 0.5.69 (2026-08-18)

## 0.5.68-dev.8 (2026-08-18)

### Feat

- **autonomous**: simply team access and separate admin control to a tab

## 0.5.68-dev.7 (2026-08-17)

### Feat

- **rag**: refactor knowledge bases (#2324)

### Fix

- **helm**: make chart docs generation portable (#2383)

### Refactor

- **ci**: use native architecture prebuilds (#2385)

## 0.5.68-dev.6 (2026-08-13)

### Fix

- **helm**: pin third-party MCP image versions (#2381)
- **ui**: add workflows breadcrumbs (#2379)

## 0.5.68-dev.5 (2026-08-12)

### Fix

- **ui**: prevent sidebar collapse flash (#2378)

## 0.5.68-dev.4 (2026-08-12)

### Feat

- **ui**: unify application navigation and settings (#2235)

## 0.5.68-dev.3 (2026-08-12)

### Fix

- **docs**: migrate canonical links to caipe.io (#2374)
- **ci**: skip UI test comments for fork PRs (#2376)
- **ui**: stop failed conversation deletes from silently reappearing (#2371)

## 0.5.68-dev.2 (2026-08-12)

### Fix

- **auth**: enforce catalog credential boundaries (#2375)
- **ci**: rag prebuild wrong the whole time
- try again???
- **docs**: show mobile navigation menu (#2364)
- **docs**: make site responsive across viewports (#2362)
- **docs**: publish site at caipe.io root (#2361)
- ci-rag was wrong the entire time. this is great. this is life
- **ci**: PR comment with prebuild images permission was broken...............

## 0.5.68-dev.1 (2026-08-08)

## 0.5.68 (2026-08-06)

### Feat

- **helm**: resolve object storage from a shared global.storage.s3 block

## 0.5.67-dev.1 (2026-08-06)

### Fix

- **ui**: preserve explicit unlinked-SA agent grants across visibility demotion

## 0.5.67 (2026-08-04)

### Fix

- **ui**: grant unlinked service account can_use when agent shared with Everyone

## 0.5.66-dev.1 (2026-08-04)

### Feat

- **ui**: add dropped input files panel to metrics tab
- **dynamic-agents**: track dropped input files and add multimodal regression harness

## 0.5.66 (2026-07-31)

## 0.5.65-dev.1 (2026-07-30)

### Fix

- **slack-bot**: route messages with file attachments (#2328)

## 0.5.65 (2026-07-30)

## 0.5.64-dev.1 (2026-07-30)

### Fix

- **dynamic-agents**: send text-family documents as A (#2327)

## 0.5.64 (2026-07-29)

## 0.5.63-dev.4 (2026-07-29)

### Feat

- **ui**: allow chat title edit and open links in a new tab
- **dynamic-agents**: offload multimodal attachment bytes to object store
- **dynamic-agents**: name model in skip warning, notify the model, and cap input attachments
- **dynamic-agents**: declare per-model input capabilities and degrade cleanly
- **ui**: show uploaded attachments in the chat transcript
- **ui**: attach files to chat messages as multimodal input
- **slack-bot**: forward Slack attachments as multimodal chat input
- **dynamic-agents**: support multimodal file+text chat input

### Fix

- **dynamic-agents**: pin boto3 to satisfy pinned-deps CI check
- **ci**: skip PR version-bump auto-commit for Dependabot PRs (#2322)
- **dynamic-agents**: coerce GridFS namespace components to str before Mongo queries (#2319)
- **dynamic-agents**: don't double-add Anthropic prompt-caching middleware
- **dynamic-agents**: use native prompt-caching middleware for Bedrock
- **dynamic-agents**: declare boto3 without a version pin
- **dynamic-agents**: pin boto3==1.43.16 to match cnoe-agent-utils
- **dynamic-agents**: thread files into _stream_impl so attachments reach the model
- **dev**: clear OIDC_AUDIENCE for dynamic-agents so OBO tokens validate
- **slack**: reject Slack files:read login-page HTML before sending to model

## 0.5.63-dev.2 (2026-07-28)

## 0.5.63-dev.1 (2026-07-28)

### Feat

- **rag**: self-service RAG ingestion-source config store (PR1/7) (#2286)

## 0.5.63 (2026-07-28)

### Fix

- **credentials**: load caller teams in secret sharing (#2312)

## 0.5.62 (2026-07-26)

## 0.5.61-dev.3 (2026-07-24)

### Fix

- **webex-wdm**: also refresh WDM device on ConnectionClosedOK
- **webex-wdm**: refresh WDM device on ConnectionClosedError to avoid stale webSocketUrl loop
- **skills**: isCatalogKey must match user:-prefixed subject
- **skills**: catalog key returns hub and global agent_skills, not only default
- **skills**: catalog key and local skills JWT missing sub drops all skills

## 0.5.61-dev.2 (2026-07-24)

### Fix

- **rag**: recurse into sitemap index children instead of scraping them as pages (#2293)

## 0.5.61-dev.1 (2026-07-24)

### Fix

- **CI**: ui

## 0.5.61 (2026-07-24)

## 0.5.60-dev.5 (2026-07-24)

### Fix

- **ui**: add proactive session keepalive to prevent SSO idle timeout (#2288)

## 0.5.60-dev.4 (2026-07-23)

### Fix

- **webex**: add per-user OAuth token support via X-CAIPE-Provider-Token
- **confluence**: add OAuth Bearer auth for Atlassian 3LO tokens

## 0.5.60-dev.3 (2026-07-23)

### Fix

- **insights**: scope user drawer and paginate top users (#2285)

## 0.5.60-dev.2 (2026-07-23)

### Feat

- **ui**: link feedback trends to daily feedback (#2283)
- **docs**: include info on UI admin access to update scheduler ediotr agent
- **helm**: change restrictedMcpServers default to none and update docs on how to restrict scheduler to admin only
- **scheduler**: allow admin to modify default schedule editor agent in the ui

### Fix

- fix scheduler ui tab acceess
- **scheduler**: if admin only access do not make scheduler tab visible for normal users

## 0.5.60-dev.1 (2026-07-23)

### Fix

- **rag**: RAG RBAC coverage audit and dead-code cleanup (#2269)

## 0.5.60 (2026-07-23)

### Fix

- **rbac**: sync OIDC group membership tuples without pre-configured rules (#2282)

## 0.5.59-dev.1 (2026-07-23)

### Feat

- **ui**: remote MCP catalog with OAuth credential connectors (#2263)

## 0.5.59 (2026-07-23)

### Fix

- **helm**: default dynamic-agents CAIPE_API_URL from release name (#2255)
- **ci**: stop hard-failing CI for fork PRs from outside contributors (#2281)

## 0.5.58-dev.3 (2026-07-22)

### Feat

- **ui**: add admin filter deep links (#2279)

### Fix

- **ci**: disambiguate digest artifact patterns to prevent name-prefix collisions (#2277)

## 0.5.58-dev.2 (2026-07-22)

### Feat

- **metrics**: add steady-state operations dashboard (#2278)

## 0.5.58-dev.1 (2026-07-22)

### Fix

- **ui**: compare positive and negative feedback trends (#2276)

## 0.5.58 (2026-07-22)

### Fix

- **ci**: build remaining 11 CI image workflows natively per-arch (#2274)
- **workflow**: do global check correctly
- **ci**: build rag images natively per-arch instead of QEMU-emulated arm64 (#2272)

## 0.5.57 (2026-07-22)

## 0.5.56-dev.4 (2026-07-22)

### Fix

- **insights**: apply filters consistently across cards (#2270)

## 0.5.56-dev.3 (2026-07-22)

### Fix

- **insights**: count only assistant messages (#2267)

## 0.5.56-dev.2 (2026-07-22)

### Fix

- **ui**: load admin insights cards independently (#2260)

## 0.5.56-dev.1 (2026-07-22)

### Fix

- **insights**: refresh stats and restore user activity (#2259)
- **autonomous-agents**: gate unpublished chat links

## 0.5.56 (2026-07-21)

## 0.5.55-dev.6 (2026-07-21)

### Fix

- **insights**: remove self-resolution and est. hours saved stats (#2256)

## 0.5.55-dev.5 (2026-07-20)

### Fix

- **ci**: scope GitHub App token permissions in prebuild artifact comment workflow (#2250)

## 0.5.55-dev.4 (2026-07-20)

## 0.5.55-dev.3 (2026-07-20)

### Feat

- **ui**: mint signed agent context for MCP tool callers

### Fix

- **openfga-bridge**: shorten local context TTL to 8h, fix audit obj, add prebuild image flow
- **ui**: stop revoking agent-context grants before caller can use them

## 0.5.55-dev.2 (2026-07-20)

### Feat

- **ui**: scope admin insights by owned agents and add agent filter (#2209)

## 0.5.55-dev.1 (2026-07-20)

### Feat

- **auth**: OIDC_GROUP_INCLUDELIST and OIDC_GROUP_EXCLUDELIST for AD group sync filtering (#2237)
- **ci**: link failed CIs and initiated gh user in the release draft to take action

### Fix

- **e2e**: drive the MCP tool picker as a combobox, not a <select>
- **service-accounts**: let org admins manage service accounts outside their own team
- **service-accounts**: org admins see all SAs; add search + pagination
- **autonomous-agents**: authenticate dynamic agent calls

### Refactor

- **mcp**: restyle MCP lab tool picker as a searchable combobox

## 0.5.55 (2026-07-17)

## 0.5.54-dev.3 (2026-07-17)

### Feat

- support multiple Webex bots and 1:1  (#2184)

## 0.5.54-dev.2 (2026-07-16)

## 0.5.54-dev.1 (2026-07-16)

### Feat

- **platform**: add per-surface default agents (#2233)

## 0.5.54 (2026-07-16)

## 0.5.53-dev.5 (2026-07-16)

## 0.5.53-dev.4 (2026-07-16)

### Fix

- **slack-bot**: resolve channel_id from view.private_metadata for modal submits
- **slack-bot**: bind OBO token in feedback/retry/escalation handlers
- **slack-bot**: register conversation before VictorOps on-call lookup

## 0.5.53-dev.3 (2026-07-16)

### Feat

- **ui**: improve admin access preview and default agents (#2218)

### Fix

- **admin-users**: create team_membership_sources index at boot, not via migration
- **admin-users**: drop stray teams dep causing double-fetch on Users tab
- **admin-users**: paginate team membership lookup in Mongo, not Node
- **admin-users**: page team-scoped Keycloak lookups for plain members

## 0.5.53-dev.2 (2026-07-16)

### Feat

- **ci**: add prebuild webex bot. WHY WAS THIS NOT ADDED BEFORE?

### Fix

- **ui**: eliminate lint violations and enforce CI (#2211)

## 0.5.53-dev.1 (2026-07-16)

### Feat

- **ui**: animate shared tab selectors (#2217)

## 0.5.53 (2026-07-15)

## 0.5.52-dev.2 (2026-07-15)

### Feat

- **keycloak**: configurable SSO session lifetime, default 7d idle / 14d max

### Fix

- **ui**: remove AccessTokenMissing dead code and clear auth flag on recovery

## 0.5.52-dev.1 (2026-07-15)

### Feat

- **ui**: add 'Choose agent' button alongside 'Resume with default agent' in deprecated-agent banner

### Fix

- **ci**: resolve ruff and jest failures blocking deprecated-agent PR
- **ui**: patch Zustand store after re-linking deprecated-agent conversation
- **ui**: show history and resume CTA for deprecated-agent conversations

## 0.5.52 (2026-07-15)

### Fix

- **ui**: scroll unlinked access modal body instead of overflowing

## 0.5.51-dev.5 (2026-07-15)

### Fix

- **slack-bot**: pass agent_id when resolving conversation for message delete
- **slack-bot**: pass agent_id when resolving conversation for Get help escalation

## 0.5.51-dev.4 (2026-07-15)

### Fix

- address autonomous agents review feedback

## 0.5.51-dev.3 (2026-07-15)

### Fix

- **ui**: tolerate transient silent-refresh failures before forcing logout (#2220)
- **ui**: add deep links for agent resources (#2212)

## 0.5.51-dev.2 (2026-07-14)

### Feat

- **dynamic-agents**: pass METRICS_PORT through in dev compose
- **dynamic-agents**: make metrics port configurable

## 0.5.51-dev.1 (2026-07-14)

### Fix

- **ui**: repair admin view-as access preview (#2206)

## 0.5.51 (2026-07-13)

## 0.5.50-dev.2 (2026-07-13)

### Fix

- **slack-bot**: demote profiling stage logs from INFO to DEBUG
- **slack-bot**: filter OpenFGA tuple read server-side by channel subject
- **slack-bot**: add stage timing logs to profile routing delay

## 0.5.50-dev.1 (2026-07-13)

### Feat

- **idp-sync**: log per-stage progress through a directory sync
- **docs**: add vidcast links for scheduler and mcp webex meetings

### Fix

- **idp-sync**: make the plan/reconcile chain async and O(n) to keep probes alive
- **idp-sync**: yield the event loop during synchronous member passes
- **idp-sync**: bootstrap baseline access before team apply and parallelize member resolution
- **rbac**: bootstrap member baseline for directory-synced users
- **autonomous-ui**: remove duplicate Sparkles import from merge

## 0.5.50 (2026-07-10)

## 0.5.49-dev.2 (2026-07-10)

### Fix

- **dynamic-agents**: repair general-purpose tool results (#2196)

## 0.5.49-dev.1 (2026-07-10)

### Fix

- **slack-bot**: mint unlinked SA token for bot_message-subtype mentions
- **slack-bot**: resolve bot identity for Workflow Builder @mentions
- **slack-bot**: resolve bot identity for Workflow Builder @mentions

## 0.5.49 (2026-07-10)

## 0.5.48-dev.3 (2026-07-10)

### Fix

- **dynamic-agents**: restore tool result invariants (#2182)
- **rbac**: stop masking real Keycloak lookup failures as not-found
- **rbac**: treat 409 from createGroupRoleMapper as already-exists success
- **rbac**: yield the event loop periodically during Okta IdP sync
- **rbac**: sanitize Okta names and treat already-linked as success

## 0.5.48-dev.2 (2026-07-10)

### Fix

- **rbac**: default channel/space onboarding to mention-only listen mode

## 0.5.48-dev.1 (2026-07-10)

### Feat

- **ui**: animate header brand and navigation (#2187)

## 0.5.48 (2026-07-10)

### Fix

- **rbac**: register real Keycloak federated identity for Okta-sync users (#2181)
- **rbac**: stop splitting Slack bot/user names on spaces (#2180)

## 0.5.47-dev.1 (2026-07-10)

### Fix

- **security**: NoSQL injection, playwright Node CVEs, ingestors apk upgrade (#2160)

## 0.5.47 (2026-07-09)

### Fix

- **rbac**: chunk OpenFGA batch-check calls over the 50-check limit
- **ui**: paginate dynamic agents fetch in slack integration pickers

## 0.5.46-dev.1 (2026-07-09)

### Fix

- **rbac**: self-check should not expect manager grant for shared-only teams on agents

## 0.5.46 (2026-07-09)

## 0.5.45-dev.2 (2026-07-09)

### Fix

- **workflows**: resume subagent HITL timelines
- **ci**: fix docs-snapshot push auth + retry on race (#2154)

## 0.5.45-dev.1 (2026-07-09)

### Fix

- **ci**: exclude docs/src/pages/index.tsx from proprietary content check
- **deps**: bump uv constraint 0.11.6 to 0.11.18 in scheduler and webex-meetings

## 0.5.45 (2026-07-09)

## 0.5.44-dev.1 (2026-07-09)

### Fix

- **ci**: add exponential backoff for apk retries; add missing workflows doc (#2153)

## 0.5.44 (2026-07-09)

## 0.5.43-dev.2 (2026-07-09)

### Fix

- **caipe-ui**: use X-CAIPE-Provider-Token for Webex MCP credential source (#2150)

## 0.5.43-dev.1 (2026-07-09)

### Fix

- **workflows**: restore subagent HITL and live run status (#2142)

## 0.5.43 (2026-07-09)

### Feat

- **caipe-ui**: show HITL input form inline in chat WorkflowRunCard (#2148)

### Fix

- **slack-bot**: remove stale user_allowed kwarg from SlackChannelRebacDecision (#2152)

## 0.5.42 (2026-07-08)

### Fix

- **ui**: sharing a dynamic agent with a team is use-only, not manage
- **slack-bot**: paginate accessible agents list beyond first page

## 0.5.41-dev.1 (2026-07-08)

### Fix

- **okta-sync**: resilient large org syncs with better error diagnostics
- **okta-sync**: add error handling and throttling for large org syncs

## 0.5.41 (2026-07-08)

### Fix

- **openfga**: add argocdHookDeletePolicy support to job-init.yaml (#2141)
- **dynamic-agents**: restore subagent timeline correlation

## 0.5.40-dev.1 (2026-07-07)

### Fix

- **workflows**: restore workflow error marker
- **workflows**: describe workflow state as logs
- **workflows**: keep workflow state read-only

## 0.5.40 (2026-07-07)

### Feat

- **agentgateway**: optional explicit stats/readiness bind addresses

## 0.5.39-dev.1 (2026-07-07)

### Fix

- **keycloak**: fix two more compact-JSON id lookups; add shared helper
- **keycloak**: make init-idp.sh role-id and redirector parsing robust

## 0.5.39 (2026-07-07)

## 0.5.38-dev.4 (2026-07-07)

### Fix

- **webex**: allow markdown-only messages (#2127)

## 0.5.38-dev.3 (2026-07-07)

### Fix

- **workflows**: use exact match for Completed text in sharing e2e tests
- **workflows**: remove unused buildDefaultWorkflowCatalog import

## 0.5.38-dev.2 (2026-07-07)

### Fix

- **openfga**: make migrate job hook delete policy configurable (#2130)

## 0.5.38-dev.1 (2026-07-06)

### Feat

- **rag**: add opt-in bypass for SSRF protection on web ingestion

### Fix

- **dynamic-agents**: filter Deep Agents internal summarization chunks from SSE stream
- **dynamic-agents**: harden default middleware stack from 0.4.18-hotfix
- **slack-bot**: port thread-reply, bot-fallback, and VictorOps fixes from 0.4.18-hotfix

## 0.5.38 (2026-07-06)

### Feat

- **dynamic-agents**: add Import from YAML config adoption flow

### Fix

- **keycloak**: reconcile CLI client on the always-on token-exchange job
- **keycloak**: reconcile public CLI client on upgrade, not just first boot

## 0.5.37 (2026-07-06)

## 0.5.36-dev.1 (2026-07-06)

### Feat

- **doc**: add new doc page for webex meetings mcp
- **webex-meetings**: add new mcp server for webex-meetings

### Fix

- **chart**: add to tags and disable by default
- put existing email

## 0.5.36 (2026-07-04)

## 0.5.35-dev.1 (2026-07-04)

### Feat

- **docs**: clean up comments and add a docs page
- **openfga-authz-bridge**: add restrictedMcpServers for admin access only

### Fix

- **ci**: helm prebuild
- **ci**: optimise reconcile-prebuild-artifacts.py to filter on pr head sha
- further attempt to fix prebuild-artifact-comment.yml
- fix ci

## 0.5.35 (2026-07-02)

### Feat

- **rbac**: archived teams grant no access, with self-check repair
- **idp-sync**: upsert user names and team/membership data from Okta
- **dynamic-agents**: add search and pagination to agents list
- **keycloak**: add configurable caipe-cli public client for local dev tokens
- **scheduler**: JWT to be passed to mcp-scheduler (relay) and then to scheduler service which validates and derives owner_sub
- 5.6-sol is too much and out of control
- **workflows**: make workflow runs shareable for collaborative debugging

### Fix

- **admin**: fix PrometheusCharts Tooltip content type cast
- **admin**: fix PrometheusCharts TS cast to satisfy strict type check
- **rbac**: expect owner-team #member manager tuple in self-check audit
- **ui**: prevent scope refs from overflowing modal bounds in unlinked access dialog
- **admin**: cap metrics legend to top 5 and tooltip to top 3 series
- **identity-sync**: chunk orphan sweep updateMany to avoid $in size limit
- **identity-sync**: sweep for already-orphaned sync teams on full sync
- **service-accounts**: admins bypass team membership filter on GET
- **slack**: guard SA empty-state on displayName too
- **admin**: wrap team name + IDP badge so long names don't hide pill
- **slack**: show saved SA name when caller lacks team membership
- **identity-sync**: archive orphaned identity_group_sync teams on full sync
- **credentials**: preserve renewable flag after token refresh and guard needsAutoRefresh
- **admin**: prevent Okta pill text from overflowing rounded border
- **rebac**: search channels by ID in onboarding tab
- fix ci
- ci mcp wtf
- **metrics**: correct agentgateway stats port and openfga SM init pod exclusion
- **servicemonitor**: exclude openfga init job pods from openfga ServiceMonitor
- **docs**: remove /docs redirect that conflicts with docs plugin root page
- security
- **ui**: show schedule run title on the chat
- reconcile all cron runner image upon deploy and indicate on the schedule modified history
- dockerfile migration to build/
- missing changes
- **workflows**: org-admins can always access any run for troubleshooting

## 0.5.34-dev.1 (2026-07-02)

### Fix

- **metrics**: exclude per-component services from umbrella ServiceMonitor and expose openfga metrics port
- **setup**: make setup-caipe.sh cleanup orphan-safe, and extend Keycloak install timeout (#2096)

### Refactor

- **setup-caipe**: More to nuke (#2099)

## 0.5.34 (2026-07-01)

### Feat

- **conversations**: open Slack conversations to all thread participants

### Perf

- **admin**: use fast teams endpoint in user detail modal fallback
- **admin**: use fast teams endpoint in connector onboarding wizard
- **admin**: lazy-load sessions and federated identities in user detail modal
- **admin**: reuse parent teams list in user detail modal
- **admin**: parallelize user detail loading and progressive-render modal

## 0.5.33-dev.2 (2026-07-01)

### Fix

- **metrics**: expose keycloak management port and add per-component ServiceMonitors
- **rbac**: add team#member to agent manager relation in OpenFGA model
- **agents**: show correct read-only message when user lacks edit permission
- **agents**: grant owner team members full manage access on agents

## 0.5.33 (2026-06-30)

### Perf

- **teams**: stop rewriting membership tuples on resource save

## 0.5.32-dev.1 (2026-06-30)

### Feat

- **openfga-authz-bridge**: add callerToolCheck.enabled value to subchart

## 0.5.32 (2026-06-30)

## 0.5.31-dev.1 (2026-06-30)

### Fix

- **agentgateway**: make config-bridge ext_authz host release-aware
- **docs**: correct broken cross-link in architecture/gateway.md (#2075)

### Refactor

- **agentgateway**: drop authzHostSecret, keep plain authzHost

## 0.5.31 (2026-06-30)

### Fix

- **webex**: suppress duplicate wizard title and update tests
- **webex**: add two-tab nav between Configure and Configured spaces

## 0.5.30 (2026-06-29)

### Fix

- **ui**: restore scroll in team dialog lists (#2074)

## 0.5.29 (2026-06-29)

## 0.5.28-dev.3 (2026-06-29)

### Feat

- **credentials**: PKCE public-client OAuth connectors; remove pinned MCP connection scope (#2071)
- **credentials**: add hash tabs for secrets (#2065)

### Fix

- **workflows**: avoid raw step response rendering
- **health**: probe self API routes via internal base URL, not request origin (#2067)
- signed agent context goes stale after 5min (#2069)

## 0.5.28-dev.1 (2026-06-29)

### Fix

- **chart**: A2A_BASE_URL default points to dynamic-agents:8001
- **health**: update tests and chart template for localhost self-call fix
- **health**: use localhost for self-referential capability probes

## 0.5.28 (2026-06-29)

### Fix

- **health**: restore AppHeader capability status

## 0.5.27 (2026-06-28)

### Feat

- **audit**: S3 retention controls, storage usage visibility, and configurable verbosity

### Fix

- **lint**: move verbosity import to top of test file (ruff E402/F401)
- **audit**: mock /api/admin/audit-storage in UnifiedAuditTab download test
- **rbac**: clean up deleted principals and grants

## 0.5.26-dev.7 (2026-06-28)

### Feat

- **admin**: make OpenFGA the source of truth for team resource access and declutter team UI (#2021)
- **admin**: add access explorer and rbac self check
- **admin**: drop team_kb_ownership for OpenFGA-sourced KB grants and split Agents/MCPs tabs
- **admin**: make OpenFGA the source of truth for team resource access and declutter team UI
- **autonomous-agents**: restore Autonomous UI on the dynamic-agents architecture (Stage 2)

### Fix

- **setup-caipe**: update configBridge.bff to configBridge.ui secret path (#2058)
- **ui-admin**: remove knowledge bases settings tab

### Refactor

- **autonomous-agents**: route tasks through dynamic-agents, drop supervisor

## 0.5.26-dev.6 (2026-06-27)

## 0.5.26-dev.5 (2026-06-27)

### Feat

- **audit**: S3 retention controls, storage usage visibility, and configurable verbosity

## 0.5.26-dev.4 (2026-06-27)

### Fix

- **dynamic-agents**: remove stale agent CRUD router (#2054)

## 0.5.26-dev.3 (2026-06-27)

### Fix

- **security**: address audit and pnpm alerts

### Refactor

- **ui**: collapse credentials tabs into a single scrollable pane (#2044)

## 0.5.26-dev.2 (2026-06-27)

## 0.5.26-dev.1 (2026-06-26)

### Fix

- **keycloak**: align init hook cleanup for argocd
- **keycloak**: make init-idp hook delete policy configurable
- **ci**: make auto-tag idempotent and authenticated (#2046)
- **ui**: make custom popover dropdowns work inside dialogs (#2048)

## 0.5.26 (2026-06-26)

### Fix

- **slack**: suppress ephemeral nudges for passive channel posts (#2045)

## 0.5.25 (2026-06-26)

### Feat

- **health**: refactor platform health probes to capabilities with profile-aware integration status (#2005)

### Fix

- **ui**: improve sharing/transfer UX and consolidate KB ownership (#2041)
- **slack**: batch configured channel health audit lookup (#2043)
- **ui**: cache session auth for repeated api calls
- **keycloak**: add memory headroom for slack admin loads (#2038)
- **ui**: actually use the seedConfig source for mcp
- **webex**: simplify space onboarding and direct routing
- **mcp**: stabilize tool schema and health scans
- **chat**: restore user and team share visibility (#2031)
- **admin**: collapse long user team lists (#2034)

## 0.5.24 (2026-06-26)

### Feat

- **mcp**: add mcpSecrets alias with deprecation of agentSecrets

### Fix

- **mcp**: set mcpSecrets default to empty map, guard against nil
- **mcp**: guard ExternalSecret data/dataFrom to prevent empty-list rejection
- **chart**: wire AGENTGATEWAY_TARGETS_TOKEN into caipe-ui and add dev-mode default (#2007)
- **chat**: stabilize shared conversation list access
- **chat**: show recipient share permissions
- **chat**: use shared icon for share control
- **chat**: preserve owner share controls
- **chat**: respect shared conversation edit affordance
- **chat**: show shared-by affordance to recipients
- **chat**: mark shared recipients in sidebar
- **chat**: enable team conversation sharing
- **chat**: show shared badge to recipients
- **chat**: preserve shared chat UI indicators
- **chat**: prevent private conversation visibility leak
- **slack-bot**: log SA name alongside sub in dispatch_identity (SDPL-1984)
- **slack-bot**: use None fallback for event ts (SDPL-1984)
- **slack-bot**: match bot allowlist by name OR user ID (SDPL-1984)
- **slack-bot**: skip Keycloak identity resolution in middleware for bot messages (SDPL-1984)

## 0.5.23 (2026-06-25)

### Fix

- **audit**: run store.query in thread and narrow health-check lookback to 24h (#2026)
- **okta-sync**: handle DPoP nonce requirement automatically (#2023)
- **ci**: use github token for ui ghcr push (#2024)
- **ci**: use github token for ui tag detection (#2022)

## 0.5.22 (2026-06-25)

### Feat

- **ui**: make release notes user-scoped under General and simplify config (#2017)

### Fix

- **ci**: resolve remaining zizmor findings (#2010)

## 0.5.21-dev.4 (2026-06-25)

### Feat

- **admin**: replace low-level FGA admin tools with team-based user access view (#2016)

### Fix

- **webex**: gate space access on agent assignment, not team membership (#1763)

## 0.5.21-dev.3 (2026-06-24)

### Fix

- **ai-review**: persist grade on create, align AI Suggest to rubric, and fix blocking-message UX (#2014)

## 0.5.21-dev.2 (2026-06-24)

### Feat

- **core**: remove legacy supervisor model and A2A standalone agents (#1728)

## 0.5.21-dev.1 (2026-06-24)

### Feat

- **slack-bot**: bold-italic footer hint and env.example comment cleanup (#2011)

### Fix

- **rbac**: filter OpenFGA tuples server-side in slack channel diagnostics (#2009)
- **ci**: scope sync-release-branches write perms to the sync job
- **ci**: scope overly-broad workflow permissions to jobs
- **ci**: resolve zizmor template-injection and unpinned-action findings

## 0.5.21 (2026-06-23)

### Feat

- **dynamic-agents**: add INVOKE_PERSIST_HISTORY env var to compose

### Fix

- **tests**: update tests to match new fallback and wildcard behaviour
- **rbac**: add findOneAndUpdate to migration lock test mock
- **mcp**: allow fallback_env when provider connection is unavailable
- **service-accounts**: always show wildcard in SA tool picker
- **rbac**: atomically acquire migration lock to prevent multi-replica race

## 0.5.20 (2026-06-23)

## 0.5.19-dev.3 (2026-06-23)

### Feat

- **admin,mcp**: self-service integration panel modes, bulk onboarding, and credential relink (#1985)

### Fix

- **docker-compose**: Update to wire openfga into first install ui (#1907)
- **caipe-ui**: replace per-pod token Map with MongoDB-backed L1+L2 store (#1987)

## 0.5.19-dev.2 (2026-06-23)

### Feat

- **admin**: improve health and integration diagnostics (#1992)
- **mcp**: default servers to streamable HTTP

### Fix

- **ui**: scope /api/chat/shared pre-filter to sharing-configured conversations

## 0.5.19-dev.1 (2026-06-22)

### Fix

- **ui,chart**: handle Kubernetes tcp:// port env vars and wire platform health probe hosts (#1983)

## 0.5.19 (2026-06-22)

### Fix

- **mcp**: route Confluence provider tokens through AgentGateway
- **identity-sync**: remove proactive Okta credential health check on page load (#1975)

## 0.5.18-dev.1 (2026-06-22)

## 0.5.18 (2026-06-22)

### Fix

- **charts**: default AUDIT_SERVICE_URL to release-scoped audit-service
- **workflows**: allow workflow CRUD with view permission at BFF gate
- **workflows**: let non-admins save workflows without global agent grants

## 0.5.17-dev.11 (2026-06-22)

### Feat

- **credentials**: fail closed on caller-scoped MCP OAuth with chat warnings
- **credentials**: pin provider connections on custom MCP servers
- **credentials**: improve provider connection profile and OAuth lifecycle
- **rbac**: wire agent context HMAC for Helm and document follow-up gaps
- **workflows**: include run_url in workflow status tool responses
- **workflows**: poll run status and harden chat workflow UX
- **workflows**: improve Webex workflow run tool responses and guidance
- **credentials**: harden secret dialog and add workspace regression e2e
- **workflows**: delegate workflow BFF calls to invoking user bearer
- **rbac**: reconcile platform MCP and agent OpenFGA tuples on startup
- **agents**: scope ownership checks and tighten team member grants
- **mcp**: add list permissions and gate MCP server actions in UI
- **agentgateway**: propagate MCP credential headers through bridge
- **mcp**: add AgentGateway upstream resolver and credential helpers
- **credentials**: integrate secrets UX with AgentGateway MCP routing

### Fix

- **ci**: address github-code-quality findings on PR #1967
- **credentials**: guard OAuth callback when auth user metadata is absent
- **ci**: align UI tests and e2e lint with login and chat nav changes
- **ui**: satisfy TypeScript checks in dynamic-agents list route
- **agentgateway**: repair config bridge tests after credential gating
- **ci**: stabilize workflow e2e probes and agentgateway credential forwarding
- **ci**: stabilize webex tests and gitleaks for jira JWT fixture
- **mcp**: revert #1926 AgentGateway routing opt-out
- **webex**: reduce duplicate pairing prompts and harden identity lookup
- **jira**: harden MCP API client error handling
- **webex**: improve WDM reconnection and device registration handling
- **ui**: flip popovers when viewport space is limited
- **rbac**: allow team workflow owners to run without team membership
- **mcp**: promote custom servers to agentgateway routes (#1926)
- **mcp**: promote custom servers to agentgateway routes
- **mcp**: cover agentgateway acceptance gaps
- **mcp**: promote custom servers to agentgateway routes
- **compose**: use canonical caipe-ui image tag
- **rbac**: address admin and chat regressions (#1950)

## 0.5.17-dev.10 (2026-06-21)

### Fix

- **deps**: update torch for rag embeddings (#1962)

## 0.5.17-dev.9 (2026-06-21)

### Perf

- **ui**: cache health and RBAC gate checks (#1949)

## 0.5.17-dev.8 (2026-06-20)

### Feat

- **audit**: read connector diagnostics from audit service
- **audit**: add audit-service read UI

### Fix

- **security**: remove agntcy slim sdk usage (#1955)
- **helm**: keep MCP servers while disabling A2A agents

## 0.5.17-dev.7 (2026-06-20)

### Fix

- **deps**: resolve dependabot security alerts (#1872)

## 0.5.17-dev.6 (2026-06-20)

### Fix

- **ci**: satisfy zizmor security scan

### Refactor

- **audit**: route producers through audit service

## 0.5.17-dev.5 (2026-06-20)

### Feat

- **github**: use gh cli-backed file contents tool (#1721)

## 0.5.17-dev.4 (2026-06-20)

### Feat

- **audit**: add lightweight audit service runtime (#1946)

## 0.5.17-dev.3 (2026-06-20)

## 0.5.17-dev.2 (2026-06-20)

### Fix

- **credentials**: allow team sharing authz
- **ui**: address platform health review comments

## 0.5.17-dev.1 (2026-06-19)

### Feat

- **rag**: add S3 document ingestor (#1875)
- **ui**: add dynamic agents probe; make RAG group non-critical
- **ui**: remove NPS score page, survey, and settings (#1919)

### Fix

- **setup-caipe**: Missing AGENTGATEWAY_TARGETS_TOKEN (#1914)
- **rbac**: replace unsupported $facet in team members pagination for DocumentDB (#1924)
- **ui**: stable health badge — no pulse, no flicker, debounced bad status
- **ui**: handle Kubernetes tcp:// port env vars in health probes
- **ci**: drop GitHub App token from release-finalize
- **ci**: use GITHUB_TOKEN for release publish steps

## 0.5.17 (2026-06-18)

### Feat

- **ui**: add platform health probes (#1909)
- **ui**: paginate admin teams/members/IdP-sync history + self-heal OpenFGA drift (#1916)

## 0.5.16-dev.2 (2026-06-18)

### Feat

- **rbac**: add background scheduler for IdP directory sync (#1901)

### Fix

- **autonomous-agents**: enforce run-history ownership and add admin-only access gate
- **ui**: prefer exact changelog release prompts
- **admin**: align superadmin access surfaces
- **rbac**: unblock superadmin conversations and tool grants
- **workflows**: portal visibility dropdown and fix runs-to-workflows nav (#1900)

## 0.5.16-dev.1 (2026-06-17)

### Fix

- **slack**: remove ephemeral identity verification error message (#1902)

## 0.5.16 (2026-06-17)

## 0.5.15-dev.8 (2026-06-17)

### Fix

- **agent-editor**: simplify owner team transfer (#1893)
- **rbac**: treat team managers as owner-team members (#1895)

## 0.5.15-dev.7 (2026-06-17)

### Feat

- **admin**: scope teams, users, stats, and feedback for non-admin users (#1894)
- **rbac**: expose policy manifest downloads

### Fix

- **chat**: prevent auto-create on login race and unify permanent delete logic (#1896)
- **ci**: harden release workflows and add actions scan (#1851)

### Perf

- **admin**: lazy-load tab data on first visit; parallelise stats queries (#1882)

## 0.5.15-dev.5 (2026-06-17)

### Fix

- **rbac**: upsert bootstrap idp-sync rule by ID to fix stale provider_id (#1881)
- **rbac**: expand MCP wildcard grants safely (#1889)

## 0.5.15-dev.4 (2026-06-17)

### Fix

- **slack**: let team members manage shared integrations (#1883)

## 0.5.15-dev.3 (2026-06-17)

### Fix

- unlinked service account catalog grants (#1870)

## 0.5.15-dev.2 (2026-06-16)

### Fix

- **dynamic-agents**: surface CAS 4xx as its real status instead of collapsing to 503 (#1878)
- **admin**: allow unlinked service account tool grants

## 0.5.15-dev.1 (2026-06-16)

### Fix

- **slack**: fix loguru format strings and remove noisy oauth cache debug log (#1879)

## 0.5.15 (2026-06-16)

## 0.5.14-dev.10 (2026-06-16)

### Fix

- **slack**: send service_account subject to CAS for SA-run channels; clarify route copy (#1877)

## 0.5.14-dev.9 (2026-06-16)

### Fix

- **ui**: import Button in team ownership fields (#1876)

## 0.5.14-dev.8 (2026-06-16)

### Feat

- **admin**: sync admin nested sub-tabs to the subtab URL param (#1867)

## 0.5.14-dev.7 (2026-06-16)

### Fix

- **rbac**: simplify owner-team ownership UI and drop grant-preview copy (#1873)

## 0.5.14-dev.6 (2026-06-16)

### Fix

- **ui**: soften required-field treatment on agent create form (#1865)

## 0.5.14-dev.5 (2026-06-16)

### Fix

- make AgentGateway provider-token passthrough declarative (#1859)

## 0.5.14-dev.4 (2026-06-15)

## 0.5.14-dev.3 (2026-06-15)

### Fix

- **ui**: stabilize service account RBAC e2e (#1855)

## 0.5.14-dev.2 (2026-06-15)

### Feat

- **e2e**: add Playwright tests for AI Review block UX (PR #1866)

### Fix

- **chart**:  duplicate app.kubernetes.io/name (#1845)
- **admin**: clarify unlinked access description for admins (#1861)

## 0.5.14-dev.1 (2026-06-15)

### Fix

- **admin**: default to Settings tab and rename Default Agent to General (#1862)

## 0.5.14 (2026-06-15)

## 0.5.13-dev.4 (2026-06-15)

### Fix

- **rag**: sync uv lock metadata

## 0.5.13-dev.3 (2026-06-15)

### Fix

- **jira-mcp**: add assign_issue tool using dedicated assignee endpoint (#1846)

## 0.5.13-dev.2 (2026-06-15)

### Fix

- **validate**: Remove weather-agent validation (#1790)

## 0.5.13-dev.1 (2026-06-15)

### Fix

- **setup**: production-ready setup-caipe.sh — prereqs, domain/TLS, Keycloak, dynamic agents (#1823)

## 0.5.13 (2026-06-15)

## 0.5.12-dev.9 (2026-06-15)

### Feat

- **service-accounts**: add credential passthrough for service accounts

### Fix

- **ui**: refresh mcp server list
- **service-accounts**: address PR review findings
- **credentials,slack**: static-token exchange + OpenFGA read filters
- **service-accounts**: token-provider gating, surface flags, PAT fix, dropdown dedup
- **service-accounts**: address review findings for credential passthrough
- **ui**: prevent unlinked access modal control bleed

### Refactor

- **slack**: route all Slack-bot Keycloak access through the BFF; drop direct admin creds (#1800)

## 0.5.12-dev.8 (2026-06-15)

### Feat

- **slack**: Run As identity (user / service account) + unlinked-user fallback for Slack routing (#1784)

## 0.5.12-dev.7 (2026-06-15)

### Feat

- **rbac**: combine AD group admins with super-admins team access (#1792)

### Fix

- **dynamic-agents**: bump vulnerable dependencies (#1841)

## 0.5.12-dev.5 (2026-06-15)

## 0.5.12-dev.4 (2026-06-15)

### Fix

- **ui**: keep service account team picker searchable

## 0.5.12-dev.3 (2026-06-15)

### Feat

- **rbac**: Service Accounts — team-owned bot identities + caller-keyed tool authz (#1780)
- **agentgateway**: enable agentgateway and github-mcp-server by default in 0.5.x

### Fix

- **chart**: make github mcp opt-in and pinned

## 0.5.12-dev.2 (2026-06-15)

### Fix

- **webex**: replace static agent route mappings (#1820)

## 0.5.12-dev.1 (2026-06-15)

### Feat

- **rag**: add local file upload ingestion

### Fix

- **rag**: pin pypdf dependency
- **rag**: harden local file uploads
- **rbac**: repair MCP tuple drift and gateway credentials
- **docs**: repair MDX breakage in FGA module-api contract page (#1837)

## 0.5.12 (2026-06-14)

## 0.5.11-dev.5 (2026-06-14)

### Feat

- **ui**: add ephemeral file preview in agents and workflows

### Fix

- **ui**: MCP OpenFGA reconcile, CAS-backed authz, and team sharing (#1819)
- **supervisor**: eager MCP init via A2A lifespan hook

## 0.5.11-dev.4 (2026-06-12)

### Fix

- **dynamic-agents**: restore workflow settings dropped by 020dc937f

## 0.5.11-dev.3 (2026-06-12)

### Feat

- **workflows**: workflow RBAC on CAS (re-implements #1751) (#1772)

## 0.5.11-dev.2 (2026-06-12)

### Feat

- **authz**: centralized authorization service (CAS) — core, HTTP API, admin UI

### Fix

- **cas**: restore missing workflow modules and fix PR 1770 CI failures

## 0.5.11-dev.1 (2026-06-11)

### Fix

- **setup**: auto-install kind during prerequisites check
- **setup**: auto-install missing prereqs and gate sudo on user consent

## 0.5.11 (2026-06-11)

### Feat

- **rbac**: combine AD group admins with super-admins team access

### Fix

- **test**: add role:'admin' to mock user so requireMigrationSuperAdmin passes
- **rbac**: write org-admin connector tuple for super-admins team on bootstrap

## 0.5.10-dev.3 (2026-06-11)

### Feat

- **setup-caipe**: prompt for LiteLLM proxy when Ollama is selected

### Fix

- **rag-rbac**: elevate OpenFGA org-admins to ADMIN role on ADMIN-gated endpoints
- **setup-caipe**: restore /supervisor suffix in NEXT_PUBLIC_A2A_BASE_URL
- **setup-caipe**: don't set NEXT_PUBLIC_A2A_BASE_URL to localhost when no domain
- **setup-caipe**: remove prompts for AgentGateway and RBAC runtime
- **rag**: wire OIDC providers and ingestor credentials into rag-server
- **setup-caipe**: Ollama FQDN, RAG ingestor client, and dynamic-agents bearer auth
- **openfga**: add organization#member to skill#reader and skill#user type restrictions (#1797)

## 0.5.10-dev.2 (2026-06-09)

### Feat

- **slack**: consolidate JIT shell-user provisioning into shared BFF endpoint (#1788)

## 0.5.10-dev.1 (2026-06-09)

### Fix

- **rbac**: set AFFIRMATIVE on bot's own token-exchange permission during reconciliation
- **setup-caipe**: complete Ollama k8s deployment fixes (#1786)
- **setup-caipe**: Ollama as a K8s deployment (#1695)

### Refactor

- **ui**: group flat admin components by domain + organize imports + fix all lint errors (#1791)

## 0.5.10 (2026-06-08)

### Feat

- **slack**: derive slash-command prefix from APP_NAME, enforce DM-only on all commands (#1785)

## 0.5.9-dev.4 (2026-06-08)

### Feat

- **rbac**: Okta directory sync (SDK) with JIT provisioning, IdP-sync admin UI, and admin RBAC fixes (#1783)

## 0.5.9-dev.3 (2026-06-08)

### Feat

- **ui**: dynamic nav overflow, compact right cluster, screenshot in report dialog (#1777)

## 0.5.9-dev.2 (2026-06-06)

### Feat

- **release**: add release-prerelease.yml for coordinated rc builds

### Fix

- **slack**: gate channel access on agent assignment, not team membership (#1761)
- **release**: bump version files before tagging in release-prerelease.yml
- **ci**: restore build_all input name in a2a/mcp sub-agent workflows
- **docs**: escape MDX JSX in FGA module-api spec

## 0.5.9-dev.1 (2026-06-05)

### Feat

- **ui**: make config-driven agent panels expandable for viewing

## 0.5.9 (2026-06-05)

## 0.5.8-dev.4 (2026-06-05)

### Feat

- **slack**: prefer config team in sync-from-config preview annotation
- **slack**: import channel→team binding from an optional config team field

### Fix

- **local-dev**: seed agent team grants + update RBAC-deny test for log-not-post
- **local-dev**: RBAC org-admin bypass, Slack channel admin visibility, agentgateway pin, slack-bot logging

## 0.5.8-dev.3 (2026-06-05)

### Feat

- **slack**: add channel delete and editable agent swap in channel route editor (#1749)

### Fix

- **admin**: restore migration test mocks and fix build typing
- **admin**: scope migration bootstrap alerts to manifest-backed areas
- **setup-caipe**: preserve deployed RAG embeddings on non-interactive upgrade (#1717)

## 0.5.8-dev.2 (2026-06-05)

### Feat

- **rbac**: unify ownership-transfer flow across agents, RAG KBs, and MCP tools (#1726)

### Fix

- **rbac**: reconcile skill team shares via shared shareable-resource module (#1729)
- **skills**: resolve undefined skill id on create/clone redirect

## 0.5.8-dev.1 (2026-06-04)

### Fix

- **agentgateway,keycloak**: remove unsupported extAuthz timeout field and add impersonation to caipe-platform desired roles (#1722)

## 0.5.8 (2026-06-04)

## 0.5.7-dev.14 (2026-06-04)

### Feat

- **rbac**: org-level ingest/search capabilities + FGA coverage guarantee (#1716)

### Fix

- **deps**: bump uv 0.11.6 -> 0.11.18 in agent sub-packages (#1718)

## 0.5.7-dev.13 (2026-06-04)

### Feat

- **rbac**: grant org-admin to super-admins team members
- **rbac**: org-wide and team-invoke sharing for custom MCP tools

### Fix

- **rag**: authorize custom MCP tool writes via OpenFGA instead of coarse admin
- **rbac**: harden shareable-resource access control for RAG MCP tools and KB sharing

## 0.5.7-dev.12 (2026-06-04)

## 0.5.7-dev.11 (2026-06-04)

### Feat

- **rbac**: unify group-based access control across agents, RAG datasources, and MCP tools

### Fix

- **deps**: bump aiohttp to 3.14.0 and uv to 0.11.18 for security advisories
- **setup-caipe**: wire OLLAMA_BASE_URL for in-cluster Ollama embeddings
- **agentgateway**: protect built-in MCP routes from config-bridge pruning

## 0.5.7-dev.10 (2026-06-03)

## 0.5.7-dev.9 (2026-06-03)

### Feat

- **ui**: one-click "Migrate all to latest" for schema migrations (#1658)

### Fix

- Markdown editor scroll behaviour and theming (#1685)
- **ui**: collapse consecutive identical tool chips in timeline (#1692)

## 0.5.7-dev.8 (2026-06-03)

### Feat

- **credentials**: per-user OAuth scope selection at connect time

### Fix

- **mcp**: provider-token auth, knowledge-base RAG, and authz resilience (#1702)
- **docs**: escape brace sets in OAuth scope-selection spec for MDX

## 0.5.7-dev.7 (2026-06-03)

### Feat

- **rbac**: fix RAG datasource access gap, add public datasources, reorg KB admin (#1703)

## 0.5.7-dev.6 (2026-06-03)

### Feat

- **slack-ui**: config parity, channel-admin editing, and admin save UX (#1696)

### Fix

- **rag**: migrate rag-server image to wolfi-base
- **dynamic-agents**: migrate image to wolfi-base

## 0.5.7-dev.2 (2026-06-03)

### Fix

- **rag**: migrate ingestors image to Chainguard Wolfi base

## 0.5.7-dev.1 (2026-06-02)

### Feat

- **docs**: add release (milestone) filter to triage dashboard
- **docs**: add open-issues triage dashboard + generator

### Fix

- **triage**: base release breakdown on accurate git commit ranges + per-release drill-down

## 0.5.7 (2026-06-02)

## 0.5.6-dev.3 (2026-06-02)

### Feat

- **agentgateway**: wire config-bridge sidecar into Helm for dynamic MCP routes
- **setup**: add opt-in unified LiteLLM front for chat + embeddings
- **setup**: persist Keycloak + OpenFGA on a shared Postgres
- **setup**: add `creds` command to re-print local logins
- **setup**: default local-SSO logins + UI A2A/OIDC fixes
- **setup**: public-domain SSO wiring + optional GitHub social login
- **setup**: reproduce docker-compose.dev defaults in setup-caipe.sh
- **keycloak**: add PostgreSQL database support via database.enabled

### Fix

- **skill-builder**: handle wrapped builtin-tools API response shape
- **setup-caipe**: correct azure embeddings fallback and keycloak H2 detection
- **setup-caipe**: harden --litellm azure path, bump proxy memory, warn on H2 keycloak
- **keycloak**: reconcile bot OBO target on fresh local install
- **setup-caipe**: pre-create caipe-platform-secret
- **setup**: pre-create caipe-platform-secret for the UI Keycloak admin client
- **keycloak**: add fail guards for required database fields; make KC_HTTP_ENABLED and KC_HOSTNAME_STRICT overridable

## 0.5.6-dev.2 (2026-06-01)

### Fix

- **rag**: wire OPENFGA_HTTP default from global.rag.openfga.httpUrl in rag-server
- **keycloak**: unset stale error field when migration completes successfully (#1680)
- **keycloak**: use direct role endpoint to look up impersonation role ID in init-token-exchange (#1679)

## 0.5.6 (2026-06-01)

## 0.5.5-dev.1 (2026-06-01)

### Fix

- **keycloak**: restore manage-realm role for caipe-platform service account (#1678)

## 0.5.5 (2026-06-01)

## 0.5.4-dev.2 (2026-06-01)

### Fix

- **admin**: consolidate Keycloak warnings into amber block above invariants
- **keycloak**: remove manage-realm from caipe-platform desired roles
- **keycloak**: restore literal em dashes in realm-config.json
- **keycloak**: add view-realm and manage-realm to caipe-platform service account roles

## 0.5.4-dev.1 (2026-06-01)

### Fix

- **auth**: remove per-request bootstrap admin log spam (#1670)

## 0.5.4 (2026-05-29)

### Fix

- **admin**: show KB/agent/tool counts on team cards
- **admin**: point team KB tab create links to /knowledge-bases

### Refactor

- **ui**: replace native agent/team selects with shared picker components
- **ui**: DRY up SlackChannelRebacPanel and WebexSpaceRebacPanel into shared ConnectorAdminPanel

## 0.5.3-dev.1 (2026-05-29)

### Fix

- **keycloak**: render configured realm name
- **compose**: remove duplicate volumes key in openfga-init service

## 0.5.3 (2026-05-29)

### Feat

- **cursor**: add git branch-op permission hook and reframe worktree rule

### Fix

- **rbac**: backfill admin_surface:slack manager grant for org admins

## 0.5.2-dev.5 (2026-05-29)

### BREAKING CHANGE

- with global.agentgateway.enabled=true, the chart no longer
renders Gateway API / AgentGateway custom resources by default. Set
global.agentgateway.routingMode=gateway-api to keep the previous
CRD/controller-based routing.

### Feat

- **helm**: default AgentGateway routingMode to static (CRD-free)
- **helm**: make AgentGateway CRDs optional via routingMode

### Fix

- **ui**: recover AgentGateway MCP route path from live pathPrefix shape
- **helm**: wire CAIPE UI to AgentGateway proxy for CRD-free MCP discovery
- **ui**: label collapsed nav menu
- **docs**: repair RBAC broken anchor and unreadable draw.io SVGs
- **rag**: migrate agent-ontology image to wolfi-base

## 0.5.2-dev.4 (2026-05-29)

### Feat

- **docs**: generate versioned docs at build time from release tags

### Fix

- **rag**: bump twisted to 26.4.0 to fix DNS compression DoS

## 0.5.2-dev.3 (2026-05-29)

## 0.5.2-dev.2 (2026-05-29)

### Fix

- **helm**: render SLIM endpoint defaults from release name
- **helm**: use KEYCLOAK_REALM value in realm URL defaults instead of hardcoded caipe
- **helm**: fix whitespace trimming causing YAML parse errors in deployment env blocks
- **helm**: compute release-name service URL defaults in deployment templates
- **helm**: replace hardcoded release name with {{ .Release.Name }} template
- **deps**: force uuid >=11.1.1 via overrides in ui and docs
- **deps**: bump pyjwt 2.10.1 to 2.13.0 in openfga bridge
- **ui**: collapse top bar on narrow screens

## 0.5.2-dev.1 (2026-05-29)

## 0.5.2 (2026-05-29)

### Fix

- **dynamic-agents**: highlight missing owner team inline

## 0.5.1-dev.12 (2026-05-29)

## 0.5.1-dev.11 (2026-05-29)

### Feat

- **admin**: harden ReBAC assignment operations
- **slack**: redesign admin Slack onboarding into Configured/Onboard/Advanced tabs
- **auth**: centralize local-dev auth bypass behind a provider

### Fix

- **admin**: use exact OpenFGA tuple filters in inspector
- **rbac**: remove legacy RAG group fallback wiring
- **setup-caipe**: Disable ENABLE_METALLB/ENABLE_INGRESS when user declines
- **setup-caipe**: use native Anthropic model ID for Claude Haiku 4.5

## 0.5.1-dev.9 (2026-05-29)

### Fix

- **rag-ingestors**: block SSRF and lock TLS dependencies

## 0.5.1-dev.8 (2026-05-29)

### Fix

- **dynamic-agents**: forward user JWT to MCP clients

## 0.5.1-dev.7 (2026-05-29)

### Feat

- **admin**: add Keycloak migration health surfaces

### Fix

- **keycloak**: type management permissions enabled flag

## 0.5.1-dev.6 (2026-05-28)

### Feat

- **agentgateway**: add MCP route bridge for RBAC runtimes

### Fix

- **rbac**: grant baseline MCP gateway caller access
- **agentgateway**: preserve provider backend auth policies

## 0.5.1-dev.5 (2026-05-28)

## 0.5.1-dev.4 (2026-05-28)

### Feat

- **keycloak**: reconcile strict client secrets
- **openfga**: add route capabilities to canonical model
- **ui**: map withAuth routes to RBAC capabilities

### Fix

- **ui**: type explicit withAuth capabilities
- **ui**: keep withAuth fallback capabilities explicit
- **credentials**: align OAuth envelope store defaults

## 0.5.1-dev.2 (2026-05-28)

## 0.5.1-dev.1 (2026-05-28)

### Feat

- **ai-review**: overhaul agent and skill rubric criteria and weights (#1608)

## 0.5.1 (2026-05-27)

### Feat

- **rbac/ui**: gate Graph tab on any-KB-readable + add follow-up spec
- **rbac**: add data_source and mcp_tool OpenFGA types + BFF list filter
- **rbac**: share knowledge bases with teams via OpenFGA reconciler
- **rbac/ui**: per-tab OpenFGA gates and empty states for Knowledge sidebar
- **rbac/ui**: gate Graph tab on any-KB-readable + add follow-up spec
- **rbac**: add data_source and mcp_tool OpenFGA types + BFF list filter
- **rbac**: share knowledge bases with teams via OpenFGA reconciler
- **rbac/ui**: per-tab OpenFGA gates and empty states for Knowledge sidebar

### Fix

- **rbac**: complete RAG OpenFGA access model
- **rbac**: read KB tuples with valid OpenFGA query
- **rbac**: grant ingestor on shared knowledge bases
- **rbac**: classify admin_surfaces schema area for registry guardrails
- **rbac**: explicit org-admin super-grant on KB / Search / Data Sources / Graph / MCP Tools
- **rag-ui**: show RAG admin status without exposing email
- **rbac**: complete RAG OpenFGA access model
- **rbac**: read KB tuples with valid OpenFGA query
- **rbac**: grant ingestor on shared knowledge bases
- **rbac**: classify admin_surfaces schema area for registry guardrails
- **rbac**: explicit org-admin super-grant on KB / Search / Data Sources / Graph / MCP Tools

## 0.5.0-dev.2 (2026-05-27)

## 0.5.0-dev.1 (2026-05-27)

### Feat

- **admin/rebac**: persist onboarding defaults with Save UX and team picker
- **rbac**: persist agent "Share with Teams" in OpenFGA with backfill
- **ui**: searchable TeamPicker and TeamMultiPicker components
- **rbac**: GET /api/admin/teams returns canonical member_count
- **rbac**: add canonical team-membership reader helper
- **seed**: bootstrap a default Hello-World agent and an auto-create-teams sync rule on a fresh install
- **rbac**: opt-in login-time team auto-creation via IDENTITY_SYNC_LOGIN_AUTO_CREATE_TEAMS
- **ui**: add unsafe RBAC bypass flag

### Fix

- **rbac**: align team admin CI with canonical membership
- **slack-bot**: surface RBAC denials and stop silent retries
- **dynamic-agents**: surface LLM config errors instead of generic chat failure
- **rbac/ui**: let read-only viewers load default platform agent
- **scripts**: coerce team _id to ObjectId in canonical-team-membership $unset
- **rbac**: chunk OpenFGA writes and make identity-group-sync apply transactional

### Refactor

- **admin/rebac**: swap native team <select>s for searchable TeamPicker
- **rbac**: drop teams.members[] writes from all paths
- **ui**: consume team.member_count on Admin Teams page
- **rbac**: migrate read-only API consumers to canonical team-membership store
- **rbac**: migrate auth gates to canonical team-membership store

## 0.5.0 (2026-05-26)

### BREAKING CHANGE

- The exported helpers `ensureTeamClientScope`,
`ensurePersonalTeamClientScope`, `deleteOrphanTeamClientScopes`,
`selectAgentGatewayActiveTeamScope`, `deleteTeamClientScope`, and
the `PERSONAL_TEAM_*` / `isPersonalTeam*` symbols have been
removed from `@/lib/rbac/keycloak-admin`. Any out-of-tree
consumer relying on those imports must migrate to the new
data-layer derived team model and use
`scripts/cleanup-team-keycloak-scopes.sh` for one-time legacy
realm cleanup.

### Feat

- new tool get_file_line_count and ask agent to use that before read_file
- **dynamic-agents**: blocker hint on editor + protect platform default agent
- **rbac**: persisted onboarding defaults in `platform_config` (UI + BFF)
- **rbac**: wire up DM personal commands in Slack + Webex bots
- **rbac**: phase 2 — team-agnostic OBO + personal DM commands + UI broadening
- **rbac**: phase 1 — channel-context envelope + RAG team derivation
- **rbac**: phase 1 — BFF PDP helpers + user DM preference (additive)
- **rbac**: admin-configurable discovery cache TTL for Slack/Webex onboarding
- **rbac**: openfga admin-implies-member + auto-provision Super Admins team
- **setup-caipe**: expand embeddings menu to all 7 EmbeddingsFactory providers + Voyage AI

### Fix

- **chart/caipe-ui**: include workflow_configs in app-configmap
- **rbac**: scoped team admins can edit/delete/configure their own team (#1509)
- **docs**: escape pipes inside table-cell code spans (file-map.md)
- **docs**: unbreak MDX build of file-map.md (nested backtick → bare <slug>)
- **rbac**: silence github-code-quality findings on bot Protocol bodies
- **rbac**: detect & heal non-deterministic active_team in OBO tokens
- **rbac**: drop _id from TeamDoc so insertOne typechecks
- **deps**: add missing cachetools dep used by keycloak_authz
- **deps**: refresh stale MCP uv.lock files (jira, aws, litellm)
- **deps**: pin aiohttp, websockets, and @aws-sdk/client-kms to exact versions
- **deps**: bump fastmcp constraint to 3.3.1 in victorops agent and regenerate lock files
- **ci**: use github.token for GHCR login across all workflows
- **setup-caipe**: pull Ollama embedding model
- **ci**: use org-scoped token with explicit repo constraint for GHCR pushes
- **ci**: use org-scoped token for GHCR pushes
- **ui**: use users.conversations for Slack channel discovery to dodge rate limits
- **ui/slack**: drop stale env-provided Slack default agent/team and surface a warning

### Refactor

- **rbac**: demolish team-scope diagnostics and legacy cleanup script
- **rbac**: drop active_team_slug_unset warning explainer
- **rbac**: tighten stale active_team references in reconciler + slug validator
- **rbac**: simplify legacy team-scope invariants to manual_keycloak
- **rbac**: scrub stale active_team comments in BFF non-test code
- **rbac**: delete team-scope keycloak helpers + refit tests (spec 2026-05-24, T201, T204)
- **rbac**: remove active-team scope heal UI + dead invariants (spec 2026-05-24, T202, T203, T205)
- **rbac**: drop production callsites of team-scope keycloak helpers (spec 2026-05-24, T206)
- **rbac**: demolish active_team JWT claim in bots + RAG (Phase 3 §3.2, §3.3)

### Perf

- **rbac-ui**: lazy-load users + drop N+1 role lookup on admin list

## 0.4.18-dev.9 (2026-05-23)

### Fix

- **ci**: reduce prebuild status dispatch volume
- **ci**: make prebuild status dispatch best effort
- **containers**: remove fixable grype findings

### Refactor

- **agents**: remove unused strands backend

## 0.4.18-dev.8 (2026-05-23)

## 0.4.18-dev.7 (2026-05-23)

### Feat

- **keycloak**: harden client-secret bootstrap with reconcile + strict mode

### Fix

- **rbac**: kill BFF admin/admin fallback, auto-wire Keycloak Admin client, add MongoDB+NEXTAUTH strict-mode gates

## 0.4.18-dev.6 (2026-05-23)

### Feat

- **dynamic-agents**: add MCP endpoint normalizer, self-heal, and OpenFGA PDP gate

### Fix

- **dynamic-agents**: wire KEYCLOAK_URL/OIDC_ISSUER env, randomize setup-caipe MongoDB/Langfuse passwords

## 0.4.18-dev.5 (2026-05-23)

### Feat

- **rbac-wiring**: umbrella chart deps + compose + Makefile + docs + utils/auth
- **rbac**: OpenFGA ReBAC core library + admin BFF + admin UI

### Refactor

- **utils**: resolve github-code-quality findings on PR #1527

## 0.4.18-dev.4 (2026-05-23)

### Feat

- **rag**: RAG ReBAC + per-document ACL + userinfo cache

### Refactor

- **rag**: remove unreachable branch in check_kb_datasource_access

## 0.4.18-dev.3 (2026-05-23)

### Feat

- **mcp-auth**: shared mcp-agent-auth library + per-agent middleware

## 0.4.18-dev.2 (2026-05-23)

### Feat

- **bots**: Webex bot integration + Slack ReBAC additions
- **credentials**: introduce envelope-encrypted credential store and OAuth platform
- **infra**: introduce Keycloak, OpenFGA, AgentGateway and OpenFGA bridge charts
- **dynamic-agents**: add MCP endpoint normalizer, self-heal, and OpenFGA PDP gate

### Refactor

- **bots**: resolve github-code-quality findings on bot integrations

## 0.4.18-dev.1 (2026-05-22)

### Fix

- **infra**: isolate dockerignore hardening and litellm runtime fix
- **rbac**: raise instead of sys.exit in validate_rbac_docs helpers

## 0.4.18 (2026-05-22)

## 0.4.17-dev.2 (2026-05-22)

### Fix

- **jira**: create internal comments via platform API
- **dynamic-agents**: apply _strip_nulls to MCPServerConfig construction sites
- **ui**: revert interrupt_on default to undefined, consistent with other fields
- **dynamic-agents**: strip None values from MongoDB doc before pydantic validation
- **ui**: default interrupt_on to empty object instead of undefined in seed config
- **docs**: add missing RBAC/Webex architecture docs and drop dead sidebar entry

## 0.4.17 (2026-05-22)

## 0.4.16-dev.1 (2026-05-22)

### Fix

- **rag**: pin twisted==26.4.0 stable, fix Scrapy 2.16 TLS bug
- **rag**: add async start() for Scrapy 2.16 and fix start_urls rename
- **rag**: rename self.start_url to self.origin_url for Scrapy 2.16 compat

## 0.4.16 (2026-05-21)

## 0.4.15-dev.3 (2026-05-21)

### Fix

- **rag**: handle list[dict] return type in _truncate_output

## 0.4.15-dev.2 (2026-05-21)

### Fix

- **ui**: update escalation-handoff micro_prompt wording
- **ui**: update clear-role-definition micro_prompt to include personality
- **ui**: remove no-second-person-preamble AI review rule
- **ui**: persist ui, features, and interrupt_on fields in seedAgents

## 0.4.15-dev.1 (2026-05-20)

### Fix

- **security**: close reopened code scanning alerts

## 0.4.15 (2026-05-20)

### Feat

- **curl**: SDPL-1874 add allow_non_public_urls option to curl builtin tool

### Refactor

- **curl**: SDPL-1874 pass allow_non_public_urls through _validate_fetch_url

## 0.4.14-dev.2 (2026-05-20)

### Fix

- **jira**: quiet MCP server logs by default

## 0.4.14-dev.1 (2026-05-20)

## 0.4.14 (2026-05-20)

### Fix

- **security**: avoid logging HTTP error metadata
- **security**: close active CodeQL alerts

## 0.4.13-dev.9 (2026-05-20)

## 0.4.13-dev.8 (2026-05-20)

### Fix

- **security**: resolve dependency and code scanning alerts
- **ci**: make grype pr scans retryable
- **skill-scanner**: sanitize validation error details

## 0.4.13-dev.7 (2026-05-19)

### Fix

- **slack-bot**: suppress post in _post_final_response when text is empty after stripping
- **slack-bot**: restore overthink var in handle_mention for followup_prompt
- **slack-bot**: remove overthink from handle_mention — app_mentions never use it
- **slack-bot**: tie is_overthink_message to overthink.enabled in _route_to_agent
- **slack-bot**: SDPL-1866 overthink skip missing in _route_to_agent; pre-render boilerplate

### Refactor

- **slack-bot**: simplify overthink boilerplate — no Jinja, set at call site

## 0.4.13-dev.6 (2026-05-19)

## 0.4.13-dev.5 (2026-05-19)

### Feat

- **healthchecking**: add startup probes and migrate agents from TCP to HTTP probes

### Fix

- **ui**: drop stale mongo indexes, fix workflow-engine env var, improve error messages
- **skill-scanner**: return validation errors for malformed skills
- **probes**: return HTTP 503 from readiness endpoints when dependencies unavailable
- **supervisor**: register /health and /ready routes on the A2A app
- **healthchecking**: add startup probes to skill-scanner and langgraph-redis
- **healthchecking**: liveness probe semantics for dynamic-agents and rag-server

## 0.4.13-dev.4 (2026-05-19)

### Fix

- **escalation**: SDPL-1865 use last email match for VictorOps on-call lookup

## 0.4.13-dev.3 (2026-05-18)

### Fix

- **chat**: make /invoke history persistence configurable (default: ephemeral)
- **chat**: apply config_override and handle capacity errors in /invoke
- **chat**: persist conversation history on /invoke endpoint

### Refactor

- **chat**: use AsyncExitStack to unify runtime acquisition in /invoke

## 0.4.13-dev.2 (2026-05-18)

### Fix

- **agent-runtime**: guard delete_by_key_prefix against InMemoryStore

## 0.4.13-dev.1 (2026-05-18)

### Feat

- **jira**: add internal service desk comments

### Fix

- **ci**: always run image builds on tag push regardless of actor
- **jira**: type MCP client request dispatch

## 0.4.13 (2026-05-18)

## 0.4.12-dev.13 (2026-05-18)

### Fix

- **rag**: expand trusted network CIDRs default and remove init failure sleep

## 0.4.12-dev.12 (2026-05-18)

### Feat

- **ui**: add TASK_BUILDER_ENABLED toggle for Task Builder tab

### Fix

- **ui**: pin nunjucks deps and add workflowsEnabled to config test
- **dynamic-agents**: emit TOOL_CALL_RESULT for MCP tools with list-type content

## 0.4.12-dev.11 (2026-05-16)

### Feat

- **caipe-ui**: configurable default agent (#1378)

### Fix

- **ui**: group admin tabs for default agent settings
- **ci**: disable quick-sanity-on-tag workflow instead of deleting it
- **ci**: remove caipe-webex-bot from grype scan and delete quick-sanity-on-tag workflow
- **setup**: remove invalid :-  default from array expansions

## 0.4.12-dev.10 (2026-05-14)

### Fix

- **validate**: fix false-positive failures in setup-caipe.sh validate

## 0.4.12-dev.9 (2026-05-14)

### Fix

- **supervisor**: move agent sys.path setup to Dockerfile, remove runtime hack
- **supervisor**: remove litellm mcp __init__.py that shadows PyPI mcp package
- **security**: block SSRF-prone URL fetches
- **ci**: concurrency groups, skip label API calls, filter bot commits
- **ci**: reduce GitHub API calls to avoid installation rate limits

## 0.4.12-dev.8 (2026-05-14)

### Fix

- **deps**: refresh vulnerable dependency locks

## 0.4.12-dev.7 (2026-05-14)

### Feat

- **workflows**: gate workflows tab with WORKFLOWS_ENABLED env var
- **workflows**: add visibility/sharing RBAC with config-access checks on runs
- **workflows**: add Tool Access picker for step-level tool restrictions
- **da**: support boolean values in allowed_tools (true=all, false=disabled)
- **workflows**: include user email/name in trigger_info from API route
- **workflows**: add cancelled status, waiting_for_input to run cards, hide HITL forms on terminal runs
- **workflows**: show read-only banner and disable forms for config-driven workflows
- **workflows**: add config-driven workflow seeding with read-only protection
- **workflows**: add step context injection, artifact capture, and unavailable resource warnings
- **workflows**: switch export/import from JSON to YAML
- **workflows**: add workflow tools for dynamic agents with run cards and trigger info
- **workflows**: add ReactFlow-based workflow editor with skill isolation fix
- **workflows**: add workflow run deletion with file cleanup and auto-expiry
- **da**: make context panel resizable with Show Files button
- **files**: add generic files API and remove conversation file endpoints
- **workflows**: add workflow UI components and pages
- **workflows**: add workflow API routes, stores, and types
- **workflows**: add server-side workflow infrastructure

### Fix

- **slack**: update overthink tests to pass is_overthink_message in client_context
- **slack**: use is_overthink_message context var to always respond to thread @mentions
- **da**: remove client_id from log to satisfy CodeQL sensitive data rule
- **workflows**: fix retry logic and builtin_tools override format
- **workflows**: dynamic canvas layout to prevent node overlap with on_error badges
- **workflows**: normalize legacy allowed_tools [] to true in StepToolOverridePicker
- **da**: simplify curl and fetch_url builtin tool descriptions
- **workflows**: prevent add-step in config-driven workflows with warning toast
- **workflows**: correct error.txt detection and add Langfuse session grouping
- **ui**: workflow editor and run view UX polish
- **ui**: align run delete button with top row to avoid timestamp overlap
- **ui**: slow down workflow progress pulse and fix dark mode in tool approval card
- **hitl**: support multi-tool approval and fix workflow file download

### Refactor

- **ui**: extract AgentAvatar component and standardize agent prop passing
- **streaming**: extract shared AG-UI protocol and split consumers

## 0.4.12-dev.6 (2026-05-14)

### Feat

- **ui**: rename Dynamic agents label to Agents in AI Review admin
- **ui**: add AI Review module for skills and dynamic agents
- **rag**: anchor slack document fresh_until to message post time

### Fix

- **ci**: increase Node heap to 8 GB for Docusaurus builds

## 0.4.12-dev.5 (2026-05-14)

### Fix

- **deps**: upgrade cnoe-agent-utils to 0.4.0 and fix langchain-openai CVE
- **ci**: use GITHUB_TOKEN for gh pr create in docs workflows
- **ci**: replace heredocs with echo blocks in docs workflows

## 0.4.12-dev.4 (2026-05-14)

### Fix

- **deps**: bump vulnerable packages to fix Dependabot CVEs
- **docs**: fix confirmed broken links across docs
- **caipe-ui**: add initContainers support to deployment template

## 0.4.12-dev.3 (2026-05-13)

### Fix

- **slack-bot**: skip bot thread replies to prevent duplicate responses (#1417)

## 0.4.12-dev.2 (2026-05-13)

### Fix

- **slack**: skip overthink check for thread @mentions

## 0.4.12-dev.1 (2026-05-13)

### Feat

- **dynamic-agents**: add warning to curl tool configuration description
- **dynamic-agents**: add curl builtin tool for PUT/POST support

### Fix

- **ci**: remove invalid top-level description field from docs workflows

## 0.4.12 (2026-05-13)

### Fix

- **docs**: update Meeting Recordings link to CNOE YouTube channel
- security fix

## 0.4.11-dev.2 (2026-05-12)

### Feat

- **dynamic-agents**: expose agent id in self identity

## 0.4.11-dev.1 (2026-05-12)

### Feat

- make finops workflow image theme-aware
- improve litellm finops report exports
- add litellm finops mcp deployment
- add litellm mcp server
- **ci**: do not bump chart versions for ANY PR until approved
- **ci**: allow manual prebuild trigger for PRs with merge conflicts

### Fix

- **ci**: use local tags for version lookup
- avoid secret-like litellm examples

## 0.4.11 (2026-05-12)

## 0.4.10-dev.4 (2026-05-12)

### Feat

- **admin**: improve Supervisor Skills badge labels and add tooltips
- **skills**: add HIDE_BUILTIN_SKILLS flag and catalog key bypass for auth middleware

### Fix

- **auth**: restrict catalog key bypass to /skills/refresh path only

## 0.4.10-dev.3 (2026-05-12)

### Fix

- **auth**: replace brittle new-tab session refresh

## 0.4.10-dev.2 (2026-05-12)

### Feat

- **ci**: prebuild comment to be merged to one not per img
- **overthink**: replace ambiguous "the bot" with mechanism description
- **overthink**: rewrite boilerplate as stepwise prompt with explicit precedence
- **victorops**: consolidate to v2 reporting incidents, drop slim projections

### Fix

- **skills**: remove duplicate quick install command
- **skills**: simplify minted key install options
- **skills**: remove stale supervisor sync indicators
- **skills**: install Claude helper skills natively
- **skills**: use branded helper slash commands
- **skills**: preserve Claude settings on purge
- **skills**: use shared agents skill directory
- **skills**: protect quick install secrets
- **ci**: repair gateway PR checks
- **skills**: simplify gateway install experience
- **skills**: remove quick install summary chips
- **skills**: clarify quick install API key gate
- **skills**: widen gateway content layout
- **skills**: correct launch guidance wording
- **skills**: link to agent setup docs
- **skills**: collapse quick install advanced options
- **skills**: clarify launch guide commands
- **skills**: simplify gateway quick install flow
- **skills**: remove pagination from quick-install catalog URL
- **charts**: exclude caipe-ui from ServiceMonitor scraping
- **charts**: exclude non-metrics services from ServiceMonitor scraping
- **docs**: replace relative RUN.md link with GitHub URL in 0.3.x migration guide
- **ci**: add permissions: contents: read to docs-build-check workflow
- **docs**: escape MDX angle bracket in spec plan + add PR build check
- **victorops**: drop unused typing imports from chat tool
- **lint**: remove unused import, variable, and bare f-string
- **autonomous-agents**: follow-up route verifies signatures with global secret + github wire shape
- **ui/autonomous**: preserve dynamic_agent_id on form round-trip
- **autonomous-agents**: stream dynamic-agent runs so chat threads render the full breakdown

### Refactor

- **webex**: integrate Webex functionality into autonomous-agents service
- **config**: modify Settings initialization to prevent dotenv interference
- **config**: update Settings initialization to handle legacy cors_origins
- **tests**: unify test file structures and clean up code

## 0.4.10-dev.1 (2026-05-09)

## 0.4.10 (2026-05-08)

### Feat

- **overthink**: add OVERTHINK_BOILERPLATE as server-side template variable (#1364)

### Fix

- **overthink**: move boilerplate to slack-bot, inject via client_context (#1369)
- **docs**: migrate onBrokenMarkdownLinks to markdown.hooks (#1362)

## 0.4.9 (2026-05-07)

### Feat

- **docs**: redesign site — landing page, community page, teal/cyan theme (#1359)

## 0.4.8-dev.3 (2026-05-07)

### Feat

- **dynamic-agents**: HITL tool approval, GridFS backend, custom themes & bug fixes (#1351)

## 0.4.8-dev.2 (2026-05-07)

### Feat

- **ui**: add search filter and scroll to agent selection dropdown (#1361)

### Fix

- **docs**: escape MDX angle bracket in spec plan + add PR docs build check (#1360)

## 0.4.8-dev.1 (2026-05-07)

### Feat

- **skills**: release-docs skill — release notes + migration guide generator (#1356)

### Fix

- **ingestor**: prevent UnboundLocalError in finally block when client.initialize() fails (#1357)

## 0.4.8 (2026-05-06)

## 0.4.7-dev.9 (2026-05-06)

### Feat

- **mcp-aws**: add AWS MCP server with aws_cli_execute and eks_kubectl_execute (#1324)

## 0.4.7-dev.7 (2026-05-06)

### Fix

- **ui**: suppress synthetic "Task <status> (ID: ...)" filler in chat (#1275)

## 0.4.7-dev.6 (2026-05-06)

### Fix

- **tracing**: update skill_scrubber test to use renamed _strip_known_sections (#1342)

## 0.4.7-dev.5 (2026-05-06)

### Fix

- **tracing**: scrub skill/workflow content + cap span attribute size for Langfuse (#1330)

## 0.4.7-dev.4 (2026-05-06)

### Feat

- **supervisor**: add ToolCallLimitMiddleware and ModelCallLimitMiddleware with configurable env vars (#1319)

## 0.4.7-dev.3 (2026-05-06)

### Feat

- **charts**: configures Helm charts for Kubernetes Pod Security Standards Baseline compliance (#1337)

### Fix

- **slack-bot**: use correct Slack mention syntax for subteam/usergroup IDs in escalation (#1341)

## 0.4.7-dev.2 (2026-05-06)

### Fix

- **mcp**: remove trailing slash from default HTTP MCP path (#1339)
- replace bash 4+ case conversion for POSIX compat (#1340)

## 0.4.7-dev.1 (2026-05-06)

### Feat

- **skills**: admin scan override + hub-crawl pagination/caps + live crawl console (#1338)

## 0.4.7 (2026-05-05)

## 0.4.6-dev.2 (2026-05-05)

### Feat

- **ui**: warn user about unsaved changes in dynamic agent editor (#1328)

## 0.4.6-dev.1 (2026-05-05)

### BREAKING CHANGE

- the live-skills and update-skills route responses no
longer include layout/format/fragment fields and the agent catalog has
5 entries (claude, cursor, codex, gemini, opencode) instead of 6.

### Refactor

- **skills**: end-to-end overhaul — Workspace, scanner microservice, installer rewrite, multi-source hubs, history, ZIP, AI Assist (#1327)

## 0.4.6 (2026-05-05)

## 0.4.5-dev.2 (2026-05-05)

### Feat

- **setup-caipe**: UX improvements — Docker install, back-nav, upgrade detection, agent selection (#1336)
- **dynamic-agents**: add memory management with shared clients and lazy provider loading
- **autonomous**: gate feature surfaces behind flag

### Fix

- **dynamic-agents**: handle empty except in runtime cache
- **dynamic-agents**: remove unused AgentRuntime import in get_or_create
- **dynamic-agents**: prevent duplicate runtime init via single-flight future pattern
- **dynamic-agents**: update uv.lock for pinned memray
- **dynamic-agents**: pin memray dependency to 1.19.3
- **dynamic-agents**: reduce Retry-After from 10s to 5s
- **compose**: make webex-bot env vars optional to allow startup without profile

### Refactor

- **dynamic-agents**: simplify llm_clients and reduce runtime TTL to 60s
- **dynamic-agents**: remove provider guard, use cnoe-agent-utils 0.4.0 lazy imports
- **dynamic-agents**: simplify memory management — remove gunicorn and adaptive sizing
- **webex_bot**: split app.py into focused modules

## 0.4.5-dev.1 (2026-04-30)

### Fix

- **ui**: sync agents tab to URL param, include agent name in editor title (#1325)

## 0.4.5 (2026-04-29)

## 0.4.4-dev.3 (2026-04-29)

### Fix

- **rag-server**: install chromium_headless_shell and add init container chart support (#1320)

## 0.4.4-dev.2 (2026-04-29)

### Fix

- **slack-bot**: get first matched agent, wire overthink (#1315)
- **ui**: dynamic agent chat not loading skill slash commands (#1314)

## 0.4.4-dev.1 (2026-04-29)

### Fix

- **ui**: remove $facet aggregation for CosmosDB/DocumentDB compatibility (#1321)
- **docs**: fix broken link in 0.3.x-to-0.4.0 migration guide (#1316)

## 0.4.4 (2026-04-28)

## 0.4.3-dev.2 (2026-04-28)

### Feat

- **dynamic-agents**: skills integration, subagent fixes, and agent editor UX (#1299)

## 0.4.3-dev.1 (2026-04-28)

### Fix

- **ci**: oh no ui/ is NOT under ai_platform_engineering/?!?!
- **ui**: missing asyncs???
- **migration**: handle stringified artifact dicts and passthrough event types in 0.4.0 a2a migration (#1306)

## 0.4.3 (2026-04-27)

## 0.4.2-dev.1 (2026-04-27)

### Fix

- **setup**: guard empty-array expansions for bash 3.2 compat (#1304)
- **docs**: correct ci/cd for hotfix
- **ci**: -hotfix blocked by PEP 440 so use +hotfix in pyproject.toml
- **docs**: fix iframe style prop, add Releases to sidebar, remove Use Cases (#1292)

### Refactor

- **slack-bot**: replace qanda/ai_alerts config with flat agents list (v0.4.0) (#1288)

## 0.4.2 (2026-04-27)

## 0.4.1-dev.1 (2026-04-27)

### Feat

- **doc**: new cicd diagram and details
- **webex**: enhance webhook registration logic for Webex bot
- **webex**: further optimize Webex inbound bridge service for message tracking
- **webex**: enhance Webex inbound bridge service for improved message tracking
- **webex**: optimize Webex inbound bridge service for enhanced message tracking
- **webex**: further enhance Webex inbound bridge service for message tracking
- **webex**: refine Webex inbound bridge service for improved message tracking
- **webex**: enhance Webex inbound bridge service functionality
- **webex**: add Webex inbound bridge service
- **webex**: improve Webex thread mapping for task execution
- **webex**: enhance Webex thread mapping functionality
- **webex**: implement Webex thread mapping for task runs
- **autonomous**: add follow-up context handling for webhook tasks
- **autonomous**: implement follow-up context for webhook tasks
- **ui**: add agent dropdown selector in autonomous task form
- **supervisor**: canonical webhook-task prompt templates (issue triage, PR review, push notify)
- **supervisor**: create_autonomous_task returns callback_url + auto-generates webhook secret
- **supervisor**: GitHub webhook management tools for chat-driven setup

### Fix

- **skills**: fix caipe-skills.py 404, add auth fallback, simplify gateway UI (#1286)
- **webex**: handle empty string secret in Webex signature verification
- **autonomous**: ignore GitHub webhook pings
- **ui**: finalize replayed autonomous timelines
- **autonomous-agents**: tolerate empty CORS_ORIGINS from Docker env
- **ui**: repair merge fallout for autonomous chat flows
- **docs**: escape bare < in plan.md to fix MDX build error (#1285)

### Refactor

- **ui**: enhance TaskFormDialog agent selection styling

## 0.4.1 (2026-04-24)

### Fix

- **gateway**: skills install UX feedback — strip XML comments, per-hub recrawl, layout & history fixes (#1283)

## 0.4.0 (2026-04-23)

### Feat

- **ci**: auto label PRs

### Fix

- **ci**: auto tag inf commits
- **ci**: prevent inf loop for release PRs
- **ci**: bad pipefails
- **ci**: auto tag infinite loop fix
- **ci**: fix helm ci to trigger on tag
- **ci-prebuild**: use correct chart version
- **ci**: bad syntax and fix prebuild cleanup
- **ci**: fail ci if base not latest
- **ci**: need git name and email to commit
- **ci**: need to prebuild helm correctly and not prebuild img on pyproject change
- **ci**: prevent infinite ci loop :)

## 0.3.11 (2026-04-22)

### Feat

- **ci**: new release management & versioning strategy

### Fix

- **slack**: add escalation policy field and fix humble followup prompt (#1277)
- **ci**: detect image changes, chart changes and irrelevant changes
- **docker**: normalize caipe-ui entrypoint for Windows CRLF checkouts
- **admin**: correct feedback dedup, user linkage, and top user display (#1273)

## 0.3.10 (2026-04-21)

### Fix

- **admin**: resolve stats bugs, add users pagination, channel filter, and loading indicators (#1266)

## 0.3.9 (2026-04-21)

### Feat

- **supervisor**: re-register autonomous-task management tools on unified deep_agent.py
- **supervisor**: port autonomous-agents preflight handler to unified agent_executor.py

### Fix

- **helm**: single-node MCP ServiceAccounts and configurable name prefix (#1267)
- **ui**: allow local autonomous admin access
- **ui**: restore chat-store type safety
- **supervisor**: stream curl tool responses to client (#1255)
- **security**: resolve CodeQL source code alerts and update GitHub Actions (#1252)
- **docker**: upgrade base images, binaries, and patch system CVEs (#1251)
- **deps**: bump pypdf, python-multipart, authlib, langsmith to fix CVEs
- **deps**: bump langchain-openai, langchain-core, langchain-text-splitters to fix CVEs (#1248)

### Refactor

- **autonomous-agents**: centralize MongoDB and require it at startup

## 0.3.8 (2026-04-17)

### Feat

- **helm**: Enable Vertical Pod Autoscaling across all charts (#1224)

### Fix

- **supervisor**: add curl tool for PUT/POST support and web fetching (#1242)
- **Dockerfile**: Standardise non-root user configuration (#1246)

## 0.3.7 (2026-04-17)

### Feat

- **helm**: allow easy single var override of appVersion for image tag
- **helm**: allow custom ingress path for supervisor ingress

### Fix

- **slack-bot**: remove verbose per-event A2A debug logging
- **slack**: include channel_id in streaming fallback log message
- **slack**: disable streaming on channel_type_not_supported to avoid repeated failures
- **slack**: restore v0.2.41 streaming UX and suppress duplicate sub-agent output
- **slack**: include channel_id in streaming fallback log message
- **slack**: disable streaming on channel_type_not_supported to avoid repeated failures
- **slack**: restore v0.2.41 streaming UX and suppress duplicate sub-agent output
- **slack-bot**: remove nonexistent keyword_search param from RAG prompts (SDPL-1601)
- **helm**: do not neglect precious rag
- **helm**: no dig man

## 0.3.6 (2026-04-17)

### Feat

- **auth**: add dual auth middleware for shared key + OAuth2 coexistence (#1229)

### Fix

- **a2a**: isolate plan state per request to prevent cross-session leak (#1235)
- **ui**: pin @testing-library/dom to exact version 10.4.1 (#1239)
- **ui**: don't persist session-expired errors in chat history (#1236)
- **supervisor**: add defaults to ResponseFormat required bool fields (#1237)

## 0.3.5 (2026-04-17)

### Fix

- **checkpointer**: strip ephemeral skills state from MongoDB checkpoint writes (#1234)
- **setup-caipe**: resolve unbound variable errors with set -u (#1232)

## 0.3.4 (2026-04-16)

### Fix

- **middleware**: allow LLM to synthesize after RAG cap exhaustion (#1231)

## 0.3.3 (2026-04-15)

### Fix

- **ci**: bump Go 1.25→1.26 and langgraph 1.0.10→1.1.6 (#1222)

## 0.3.2 (2026-04-15)

### Feat

- **ui**: add skills gateway visual editor and /skills/gateway route (#1220)

### Fix

- **setup**: guard ConfigMap patches and enable ip_forward at runtime (#1221)
- **ci**: add contents:write permission to notify-release jobs (#1219)

## 0.3.1 (2026-04-15)

### Feat

- **rag**: add Jira issue ingestor and UI read-only datasource support (#988)

### Fix

- **slack-bot,supervisor**: streaming newlines, msg_too_long resilience, A2A skills injection (#1218)
- **rag**: rename ExampleEntityMatch to ExampleStructuredEntityMatch in common models (#1200)
- **streaming**: restore 0.2.41 streaming UX with marker gate fixes and middleware toggles (#1210)
- **ui**: auth hardening + credentials_ref env var validation (#1211)

### Refactor

- **ui**: simplify skills gallery and remove unused types

## 0.3.0 (2026-04-13)

### Feat

- **ui**: add /auth/reauth-complete page for new-tab OIDC re-auth flow
- **ci**: add weekly security CVE tracking issue workflow (#1191)
- **ui**: upgrade UI dependencies and components for v0.2.0 (#1171)
- **ui**: chat-driven task creation from "+ New Chat" on Autonomous tab
- **supervisor**: autonomous-task management tools (Phase 3)
- **autonomous-agents+ui**: scheduled fires render full A2A timeline (Phase B)
- **autonomous-agents+ui**: bidirectional autonomous chat (typed messages share supervisor context with scheduled fires)
- **ui**: autonomous tab as real chat conversations (no Mongo required)
- **ui+autonomous-agents**: pre-flight badge, per-task chat link, live next-run
- **autonomous-agents**: per-task chat threads with typed message kinds
- **autonomous-agents**: supervisor preflight ack on task create/update
- **autonomous_agents**: pin sub-agent routing via in-band prompt directive (IMP-06)
- **compose**: wire autonomous-agents service for one-command end-to-end testing
- **autonomous_agents**: admin-gate the UI proxy and hide writes from view-only users (IMP-19)
- **ui/autonomous**: deep-link run rows to chat conversations (IMP-18)
- **autonomous_agents**: publish autonomous runs into UI chat history (IMP-13)
- **autonomous_agents**: circuit breaker around supervisor A2A call (IMP-16) (#9)
- **autonomous-agents**: harden webhook signing (global secret + replay window) (#7)
- **autonomous-agents**: add UI tab for managing autonomous tasks (#6)
- **autonomous-agents**: TaskStore + full CRUD + scheduler hot-reload + CORS hardening (#5)
- **autonomous-agents**: per-task timeout and max_retries overrides
- **autonomous-agents**: retry transient supervisor failures with exponential backoff
- **autonomous-agents**: add MongoDB settings and run_store factory
- **autonomous-agents**: add MongoRunStore implementation
- **autonomous-agents**: add RunStore protocol with in-memory impl
- **autonomous-agents**: fix lint, add uv.lock and README
- starting new feature for cron autonomous agents
- **github-mcp**: add template support to create_repository tool (#1155)
- Default enable metrics endpoints (#1064)
- **dynamic-agents**: add ModelRetryMiddleware to dynamic agent runtime
- **supervisor**: add ModelRetryMiddleware, gate GitHub MCP tools, bump cnoe-agent-utils
- **ui**: add AI suggest buttons, CodeMirror editor, and markdown preview to custom agent builder
- **ui**: add AI suggest proxy route for custom agent builder
- **dynamic-agents**: add generic AI assistant suggest endpoint
- **rag**: add multi-org support to GitHub ingestor
- **rag**: add multi-account support to AWS ingestor
- **rag**: auto-track document_count in Client.ingest_documents
- **ui**: add filter chip UI to MCPToolsView
- **ui**: add custom metadata filter support in SearchView
- **rag**: add nested metadata filtering support
- **slack-bot**: add escalation workflows, fix feedback/streaming bugs (#1123)
- **dynamic-agents**: add OIDC_REQUIRED_DYNAMIC_AGENTS_GROUP env var
- **security**: Grype Scan — rename, add container scanning for all 35 images, block on critical (#1126)
- **db**: auto-migrate web feedback on app startup (#1109)
- **admin**: enhanced platform statistics with Slack integration and unified filters (#1094)

### Fix

- **ingestors**: defer credential validation to runtime in slack/webex ingestors
- **compose**: remove slack-ingestor and webex-ingestor services
- **deps**: re-lock agent uv.lock files to pin beautifulsoup4==4.14.3
- **deps**: pin beautifulsoup4==4.14.3 in utils and regenerate lock files
- **deps**: regenerate utils/uv.lock after langgraph 1.0.10 to 1.1.6 bump
- **deps**: upgrade langgraph 1.0.10 to 1.1.6 in all agents and utils
- **ui**: remove unused RefreshCw import and unused result variable
- **ui**: remove debug auth routes and harden token expiry guard
- **docker**: force HTTP/1.1 for kubectl downloads to avoid HTTP/2 errors (#1197)
- **docker**: add retry flags to glab curl download in Dockerfile.a2a (#1194)
- **supervisor**: replace RemoveMessage with synthetic ToolMessage for orphaned tool calls (#1195)
- **rag**: rename fetch_datasources_and_entity_types to list_datasources_and_entity_types in prompt (#1070)
- **docs**: replace broken relative spec link with GitHub URL (#1190)
- **docs**: escape angle bracket in plan.md to fix MDX build failure (#1189)
- **deps**: fix 31 Dependabot alerts — protobuf, starlette, urllib3, transformers, ecdsa (#1183)
- **deps**: upgrade langchain-core/langgraph/go-stdlib — post-1179 security scan alerts (#1182)
- **deps**: bump gh CLI version from 2.63.2 to 2.89.0 in Dockerfile.a2a (#1181)
- **deps**: upgrade fastmcp, starlette, fastapi, scrapy, tj-actions — HIGH security alerts (#1180)
- **supervisor**: exclude format_markdown tool in structured response mode (#1074)
- **ui**: deduplicate package-lock.json via npm install (#1177)
- **deps**: upgrade vulnerable dependencies — pypdf, langgraph, uv, webpack-dev-server, github-mcp-server (#1179)
- **aws**: omit --profile flag when no AWS_ACCOUNT_LIST profiles are configured (#1071)
- **deps**: upgrade langgraph 1.0.9→1.1.6 and langchain 1.2.6→1.2.15 to fix ImportError in CI (#1178)
- **deps**: regenerate uv.lock to fix locked sync in Docker build (#1175)
- **setup**: production setup fixes — MetalLB, Docker FORWARD, Duo SSO (#1101)
- **deps**: upgrade vulnerable dependencies across all agents and subpackages (#1173)
- **supervisor**: unify single/distributed binding, streaming conformance, RAG caps (#1151)
- **ci**: sync appVersion with chart version bump (#1174)
- **ci**: pin action refs in sync-release-branches to fix workflow file issue (#1163)
- **ui**: guard login for chat urls (#1158)
- **slack-bot**: add missing default field in test_config_loaded_from_file_path (#1165)
- **github-mcp**: bump Go builder image to 1.25-alpine (#1170)
- OIDC group display, task builder tools, and supervisor response format (#1140)
- **ui**: scheduled-run chat messages render plan + tools timeline (replay)
- **ui**: autonomous chat thread auto-appends new scheduled runs (15s poll)
- **ui**: "All" sidebar view shows autonomous chats with AUTO badge
- **autonomous-agents+ui**: runs failed with 'str' has no get; agent now optional; upcoming-runs stats bar
- **supervisor**: harden prompt_config loader (utf-8, env override, dict guard)
- **autonomous-agents**: use UUIDv5 contextId for supervisor A2A calls
- **compose**: make autonomous-agents profile self-contained and harden prod
- **autonomous_agents**: normalise+sanitise agent hint once, use everywhere
- **autonomous-ui**: unblock MongoDB-promoted admins and clear stuck loading state
- **autonomous_agents**: address PR #10 bot feedback — redact context, harden indexes, resilient startup
- **autonomous-agents**: reject inf/NaN on TaskDefinition.timeout_seconds
- **autonomous-agents**: construct motor client with UTC-aware datetimes
- **autonomous-agents**: add started_at index for global run listing
- **autonomous-agents**: preserve full per-task run history in /tasks/{id}/runs
- **autonomous-agents**: isolate run-store failures from task execution
- **autonomous-agents**: add pythonpath = ["src"] to pytest config
- **autonomous-agents**: use Literal types for discriminated union triggers
- **autonomous-agents**: address critical bugs and review feedback
- **autonomous-agents**: address critical bugs and review feedback
- **autonomous-agents**: use uv sync --locked in Dockerfile
- **autonomous-agents**: add history fallback and blocking config to A2A client
- **autonomous-agents**: address code review nits
- **autonomous-agents**: address all critical and medium review feedback
- code scanning alert no. 1832: Artifact poisoning (#1159)
- **slack-bot**: mount botConfig as file, add PDB and maxUnavailable=0 (#1154)
- **ci**: do not prebuild rag on .github file changes
- **ci**: prebuild supervisor when only subagent changes if single-node
- **ci**: use single-node syntax match for prebuilds w/o -
- **aigateway**: update multiple llm providers in a batch and use lock to fix race condition
- **ui**: fix conversations tab pagination and search
- **ui**: fix team-shared agents missing from new chat list and prevent header tab wrapping
- **ui**: update AgentTimeline test to match removed streaming cursor
- **dynamic-agents**: redact internal error details from /invoke response
- **dynamic-agents**: handle MCP tool errors gracefully and surface in UI
- **ui**: remove streaming cursor and use consistent markdown rendering in dynamic agent timeline
- **rag**: support typed filter values for bool fields in search and MCP tools
- **rag**: update ingestors for auto document_count tracking
- **ui**: fix $project exclusion/expression mix in conversations pipeline
- **ui**: avoid MongoDB 100MB $lookup limit in conversations endpoint
- **rag**: read reload_interval from top-level field instead of metadata
- **ui**: widen filter key and value inputs in SearchView
- **ui**: show reload interval for all datasources with reload_interval
- **deps**: pin langchain-core==1.2.26 to fix CVE-2025-68664 (#1125)
- **dev**: local dev no-SSO mode, Jira ADF descriptions, Docker networking (#1129)
- **mcp**: move host/port from FastMCP() constructor to mcp.run()
- **dev**: replace caipe-supervisor profile with caipe-supervisor-distributed
- **dev**: add caipe-supervisor-distributed profile alias and optional slack-bot deps
- **dev**: add caipe-supervisor-all-in-one service for single-node mode
- **deps**: upgrade nltk==3.9.4, fastmcp==3.2.0, mcp==1.26.0 for critical CVEs (#1103)
- **subagent**: raise truncation limit to let eviction system work
- **subagent**: truncate all string elements in tuple returns
- **subagent**: truncate content inside (content, artifact) tuples
- **docker**: install gh CLI in supervisor container
- **subagent**: normalize MCP tool results for content_and_artifact format

### Refactor

- **autonomous-agents+ui**: autonomous chat IS regular chat (one A2A pipeline, full timeline)
- **autonomous-agents**: multi-stage non-root Dockerfile + hardening docs (#8)
- **autonomous-agents**: drop redundant run_id index and reword motor import
- **autonomous-agents**: wire scheduler and tasks routes to RunStore
- **rag**: rename graph entity to structured entity
- consolidate A2A server into shared abstraction (#1116)
- **subagent**: make _truncate_any shape-agnostic

### Perf

- **autonomous-agents**: reuse a single httpx client across A2A retries

## 0.2.43 (2026-04-02)

### Feat

- add Grype container scan on version tag push (#1084)
- **github**: deploy GitHub MCP server as separate HTTP pod (#1077)
- create snyk-container.yml
- **backstage-ingestor**: add BACKSTAGE_AUTH_MODE for multi-mode auth
- **ui**: add data freshness visibility and cleanup controls
- **rag**: add safe bulk cleanup with failed job protection
- **rag**: update all ingestors to use get_fresh_until()
- **rag**: add fresh_until calculation and reload_interval field
- **supervisor**: add tool error resilience, workflow introspection, and form pre-population (#1062)
- **rag**: improve MCP search tools and UI
- **aws**: add AWS CLI and kubectl tools to single-node AWS subagent
- **helm**: propagate global.checkpointPersistence to all agent subcharts (#1023)
- **skills**: skills middleware integration with gateway API (#1024)
- **dynamic-agents**: add LOG_LEVEL env var and reduce log verbosity
- **dynamic-agents**: add backend cancellation for stop button
- **dynamic-agents**: add progressive turn loading and chat download
- **dynamic-agents**: add timeline UI for streaming agent responses
- **dynamic-agents**: add namespace correlation for subagent SSE events
- **ui**: redesign inline event cards with interleaved rendering
- **ui**: show tool/subagent calls inline in chat panel
- **slack**: replace custom MCP with korotovsky/slack-mcp-server v1.2.3 (#1036)
- **victorops**: multi-org support via VICTOROPS_ORGS env var

### Fix

- **rag**: restore per-result fetch_document markers + raise cap to 10 + 49 tests (#1069)
- pin all GitHub Actions to immutable commit SHAs (#1082)
- use workflow_run to post coverage comments from fork PRs (#1081)
- **ui**: add formatRelativeTimeCompact to test mocks
- **rag**: remove unused DEFAULT_RELOAD_INTERVAL import
- **rag**: remove unused pytest import
- **single-node**: use built-in system prompts for all subagents
- restore streaming cursor and remove unused variable
- **dynamic-agents**: clear sseEvents before HITL resume stream
- **dynamic-agents**: persist sseEvents to messages and auto-collapse sections
- **dynamic-agents**: fix timeline race condition on message interrupt
- **dynamic-agents**: persist turnStatus for interrupted/cancelled turns
- **ui**: simplify HITL state check, add thinking indicator
- **dynamic-agents**: include built-in tools for subagents
- **dynamic-agents**: increase botocore timeout for Bedrock LLM
- **ui**: prevent visual flash on conversation switch
- **ui**: reset agent info on conversation switch to prevent stale theme
- **ui**: eliminate duplicate API calls on chat startup
- **ui**: simplify inline event card args display
- **sse**: properly encode newlines in SSE content events
- **ui**: handle SSE newlines - empty data: becomes \n
- **ui**: improve typing indicator and fix markdown newlines

### Refactor

- **ui**: use shared formatRelativeTimeCompact utility
- **rag**: standardize ruff formatting to 2-space indentation
- **aws**: remove dynamic args schema — profiles covered by system prompt
- **dynamic-agents**: simplify agent panel and collapse by default
- **dynamic-agents**: unify DA history loading with standard chat
- **ui**: unify streaming/final markdown rendering in chat
- **dynamic-agents**: remove final_result event and runtimeStatus

## 0.2.42 (2026-03-24)

### Feat

- **argocd**: add directory_recurse parameter to create_application

### Fix

- **slack-bot**: prevent posting to main channel when thread message is deleted (#1034)
- **slack-ingestor**: detect lookback_days config changes and trigger full re-ingestion (#1035)
- **executor**: plan step attribution, false final answer, and sub-agent source bugs (#1025)
- **ui**: auto-sync system task configs when task_config.yaml changes

## 0.2.41 (2026-03-19)

### Feat

- **checkpointer**: per-agent MongoDB checkpoint isolation with auto-prefix (#1017)
- **dynamic-agents**: add file deletion from context panel
- **dynamic-agents**: add loading state and simplify file tree
- **dynamic-agents**: add files tree to context panel
- **helm**: change default imagePullPolicy from Always to IfNotPresent since we do not do stable/latest tags anymore
- **subagents**: centralise MCP mode variabled into utils
- **helm**: add mcp deployments in parent chart for single-node HTTP case
- **helm**: subagent level llm secrets will be moved to use agentSecrets instead
- **ci**: branch with *-single-node-* will not prebuild subagent images
- **helm**: add support for subagent level mcp variables and add user_input subagent prompt file mount
- rename "caipe" subagent to "user_input" subagent
- allow sub-agent level MCP mode + addr

### Fix

- **ui**: detect stale system templates in seed status check (#1020)
- **dynamic-agents**: rename logging.py to avoid stdlib collision
- **feedback**: fix DM scoring name, align Langfuse scores across Slack and UI (#1018)
- **task-config**: handle GraphInterrupt correctly as expected and not an exception error
- **helm**: remove mongodb runtime dependency
- further renaming of caipe to user_input that were missing
- **helm**: ensure single-node creates each subagent prompt configs and some cleanups

### Refactor

- **dynamic-agents**: use API endpoint for todos instead of SSE events
- **dynamic-agents**: consolidate SSE event system into stream_events.py

## 0.2.40 (2026-03-18)

### Feat

- **ui**: make built-in skills configurable and non-deletable (#1014)
- **confluence**: add configurable title-based page filtering for ingestion (#996)
- **dynamic-agents**: add per-agent gradient theme support
- **dynamic-agents**: add export YAML and clone agent actions
- **ui**: allow addMessage to preserve message IDs from checkpointer
- **ui**: load Dynamic Agent chat history on conversation open
- **dynamic-agents**: add conversations router with messages and clear endpoints
- **dynamic-agents**: switch to MongoDB checkpointer for persistent chat history
- **dynamic-agents**: add langgraph-checkpoint-mongodb dependency
- **dynamic-agents**: add admin Conversations tab for managing chat history
- **ui**: implement DynamicAgentChatPanel for phase 1 of persistent chat history

### Fix

- **dynamic-agents**: use os._exit(1) to forcefully terminate process
- **dynamic-agents**: use sys.exit(1) to ensure process terminates
- **dynamic-agents**: require MongoDB at startup with retry logic
- **dynamic-agents**: use arrow symbol in gradient theme labels
- **ui**: default thinking panel to collapsed for completed messages (#1011)
- **dynamic-agents**: update conversations.py to use UserContext parameter
- **ui**: audit chat preservation, loading UX, admin navigation, and report-a-problem (#1010)
- **ui**: add yaml dependency and fix streaming route types
- **ui**: use getAuthenticatedUser for Dynamic Agent streaming routes

### Refactor

- **dynamic-agents**: extract fatal_exit() function for reusability
- **dynamic-agents**: simplify agent_runtime.py
- **dynamic-agents**: consolidate user context into single UserContext object
- **dynamic-agents**: simplify SSE error handling
- **dynamic-agents**: consolidate access control into auth/access.py
- **dynamic-agents**: consolidate logging into logging.py
- **dynamic-agents**: rename middleware/ to auth/
- **dynamic-agents**: remove BUILTIN_TOOLS distinction
- **dynamic-agents**: make stream trackers stateless
- **dynamic-agents**: remove dead code
- **dynamic-agents**: remove prompts/ folder and extension prompt feature

## 0.2.39 (2026-03-17)

### BREAKING CHANGE

- Model config field renamed from 'id' to 'model'

### Feat

- **ui,slack-bot**: add structured timeline and plan-mode streaming (#985)
- **docs**: implement helm chart documentation generator (#1003)
- **aws-agent**: block kubectl get/describe secrets and sanitize output (#977)
- **persistence**: add Redis, Postgres, and MongoDB checkpoint and store persistence (#909)
- **docker**: add build context and volume mounts for RAG dev services (#986)
- **dynamic-agents**: add HITL forms using HumanInTheLoopMiddleware pattern
- **ui**: add VictorOps icon to integration orbit (#972)
- **dynamic-agents**: add conversation ID display and improve logging
- **dynamic-agents**: add builtin tools and API restructuring
- **dynamic-agents**: add llmSecret support for LLM credentials
- **dynamic-agents**: add seedConfig support for MCP servers and agents
- properly support all llm providers
- **single-node**: allow sub-agent level llm key
- **helm**: add dynamic-agents feature flags to caipe-ui config
- **helm**: add dynamic-agents subchart
- **dynamic-agents**: add CI/CD infrastructure
- **dynamic-agents**: add config-driven seed agents and MCP servers
- **dynamic-agents**: persist MCP warnings across chat messages
- **dynamic-agents**: add resilient MCP connections, restart runtime, and session logging
- **dynamic-agents**: add team sharing UI for visibility selection
- **custom-agents**: warn users when MCP tools are unavailable
- **custom-agents**: UX makeover with step wizard and improved tools UI
- **dynamic-agents**: fix model/provider sync and enhance UI
- **dynamic-agents**: add model selection with provider support
- **dynamic-agents**: add fetch_url built-in tool with domain ACL
- **dynamic-agents**: add subagent delegation support
- **dynamic-agents**: add Langfuse tracing support
- **ui**: separate chat views for Platform Engineer and Dynamic Agents
- **ui**: improve Dynamic Agents chat UX with agent selection
- **ui**: add Dynamic Agents admin UI and chat integration
- **dynamic-agents**: add FastAPI backend service for dynamic agent builder
- **slack-bot**: add podAnnotations support to helm chart (#943)
- **slack-bot**: add podAnnotations support to helm chart (#943)

### Fix

- **slack-bot**: improve kb search prompt for better retrieval and confidence assessment (#1009)
- **setup**: support curl-pipe execution and add welcome banner (#1004)
- **docs**: resolve broken links, fix Helm chart symlinks, and fix setup script (#1002)
- **ui**: respect DYNAMIC_AGENTS_ENABLED flag and reorder Custom Agents tab
- **docs**: add Docusaurus id to helm-docs templates for symlinked chart pages (#990)
- **caipe**: allow file writes after form collection
- **caipe**: allow CAIPE subagent to write files after form collection
- **task-config**: simplify Jira step display text
- **task-config**: move Jira step to end and only create ticket on error
- **task-config**: auto-merge on auto_approve and consistent Jira failure-only logic
- **middleware**: prevent write_todos infinite loop via after_model hook
- **dynamic-agents**: load all seed config (models, servers, agents) at startup
- **dynamic-agents**: read SEED_CONFIG_PATH env var for models config
- **dynamic-agents**: use timezone-aware datetime and add auth guard
- **dynamic-agents**: remove unused asyncio import
- **dynamic-agents**: initialize default-enabled builtin tools in config
- **dynamic-agents**: use /healthz for health probes
- **dynamic-agents**: correct transport type in example comments
- **dynamic-agents**: resolve circular import for session_id_var
- **dynamic-agents**: use JSON array format for CORS_ORIGINS config
- **charts**: update dynamic-agents dependency version to 0.2.38
- **helm**: update dynamic-agents dependency version to 0.2.36
- **dynamic-agents**: make disabled agents read-only and fix subagent filtering
- **ui**: prevent context panel overlay on narrow viewports
- **dynamic-agents**: fix model selector parsing for IDs containing colons
- **dynamic-agents**: handle MCP server connection failures gracefully
- **dynamic-agents**: use removeprefix for tool name prefix stripping
- **dynamic-agents**: truncate agent description in list view
- **dynamic-agents**: display warning events in Events panel
- **dynamic-agents**: handle warning SSE events in client
- **ui**: show 'Unknown' for deleted agents in chat list
- **dynamic-agents**: invalidate runtime cache when agent config changes
- **dynamic-agents**: show team agents to their owners
- **ui**: prevent sidebar flicker when switching conversations
- **ui**: reactive agent_id loading and enhanced Agent Info tab
- **ui**: preserve agent_id when loading conversations from server
- **ui**: correct API response parsing in NewChatButton
- **task-config**: only create Jira ticket on deployment failure
- **middleware**: catch task errors and continue workflow instead of crashing
- **middleware**: handle task errors gracefully instead of crashing workflow
- **github-mcp**: handle branch already exists in create_branch gracefully
- **deepagent**: prevent write_todos infinite loop when all tasks completed
- **policy**: include policy.lp in helm chart and handle empty policy file
- **auth**: forward OAuth2 token in /api/agents/tools proxy route

### Refactor

- **ui**: proxy write operations to dynamic-agents backend
- **charts**: replace task_config and policy with stubs
- **dynamic-agents**: use timezone-aware datetimes throughout
- **dynamic-agents**: rename model to model_id in models config
- **dynamic-agents**: move imports to top of files
- **dynamic-agents**: rename model config 'id' to 'model'
- **dynamic-agents**: replace verbose SSE events with structured JSON
- **ui**: remove AgentSelector from chat panel header

## 0.2.38 (2026-03-11)

### Feat

- improve manual release by splitting steps for easier retry

### Fix

- **ci**: github action to trigger ci properly in a new step

## 0.2.37 (2026-03-11)

### Fix

- prevent auto-redirect to shared/public conversations leaking context_id across users

## 0.2.36 (2026-03-09)

### Feat

- **policy**: add two-tier policy system with dynamic tool discovery
- **ui**: add Task Builder card to home page platform capabilities
- sub-agent to use context summarisation + refine search req
- **rag**: replace single graph_tools_enabled toggle with individual per-tool flags
- use Github app to bypass branch protection rule during release
- **task-builder**: scope custom workflows per-user
- **supervisor**: inject self-service workflows into prompt via middleware
- **agent-github**: connect to GitHub Copilot MCP API in multi-node mode (#907)

### Fix

- **a2a**: make user_id passing conditional in agent executor (#937)
- **tasks**: apply env var substitution to MongoDB-sourced task configs
- **single-node**: load GitHub MCP tools via local go run server
- **single-node**: return USER_FORM_SUBMITTED signal from CAIPEAgentResponse
- **aigateway**: handle key alias conflict from parallel tool calls
- **ui**: remove X close button from input form header
- **aigateway**: filter spend activity by user's API key
- **single-node**: send text artifact before input_required status
- **single-node**: robust HITL resume parsing and local MongoDB support
- **supervisor**: port Phase 1/Phase 2 error recovery to single-node agent
- **docker**: include vault_utils.py in supervisor image
- resolve merge conflicts with main

### Refactor

- **ui**: use dynamic APP_NAME in task builder instead of hardcoded CAIPE

## 0.2.35 (2026-03-05)

### Feat

- **aigateway**: add Vault integration and single-node agent configuration (#898)
- **ui**: add admin audit logs with export and owner search (#894)
- **ui**: add dashboard-style home page with shared conversations and insights (#896)
- **ui**: admin - add feedback visibility, NPS campaigns, and admin audit mode (#893)

### Fix

- **victorops**: fix deployment issues in victorops agent (#903)
- **slack-bot**: silence unhandled reaction event warnings (#905)
- **docs**: escape MDX curly braces in ADR to fix Docusaurus build (#902)

## 0.2.34 (2026-03-04)

### Feat

- **ui**: add share with everyone for conversations (#891)
- **ui**: live status, input-required, and unviewed message indicators (#892)
- **task-builder**: add live workflow discovery and MongoDB integration for single-node dev
- **task-builder**: add UX enhancements to visual workflow editor
- **task-builder**: add visual Task Builder with MongoDB persistence
- **ui**: add preferences modal with categorized feature flags (#865)
- add custom mention prompts (#888)
- **rag**: add configurable MCP server for RAG (#875)
- **ui**: add multiselect toggle and comma-separated values to metadata form (#880)
- **memory**: add cross-thread store and automatic fact extraction (#861)

### Fix

- **rag**: use dynamic RAG tool names instead of hardcoded list
- **rag**: make MCP authentication optional
- **ui**: use bulk API for initial datasource job fetching
- **chart**: use tags for caipe-ui and slack-bot instead of global conditions (#885)
- sub-agent needs to handle gracefully when no secret is needed
- **slack-bot**: disable retryable writes for DocumentDB compatibility (#886)
- **slack-bot**: correct image repository to caipe-slack-bot (#884)

## 0.2.33 (2026-03-03)

### Feat

- **caipe-ui**: add existingSecret support for pre-existing secrets (#862)

### Fix

- **ci**: replace pull_request_target with pull_request for security
- **auth**: return 401 when unauthenticated on protected routes (#882)
- **docs**: escape nested quotes in ADR front matter title (#881)
- **slack-bot**: skip duplicate CAIPE_URL in env map loop (#879)

## 0.2.32 (2026-03-02)

### Feat

- **slack-bot**: add X-Client-Source header and parent Helm chart wiring
- **slack-bot**: upstream Slack bot integration into CAIPE platform

### Fix

- delete old files
- move slack-bot chart under ai-platform-engineering chart
- **slack-bot**: move Dockerfile to build/ and add to release-finalize
- **slack-bot**: add CI and pre-release workflows for slack bot Docker build
- **slack-bot**: bump slack-bot chart version to 0.2.31
- **slack-bot**: add DM handler, use APP_NAME variable, and simplify streaming (#868)
- **slack-bot**: fix gitleaks false positive and UI test assertion
- **slack-bot**: address review issues from forge-slack-bot upstream validation
- **github**: multi-node uses gh CLI, single-node uses MCP STDIO

## 0.2.31 (2026-02-28)

### Fix

- align netutils chart alias and disable secrets for demo agents (#871)

## 0.2.30 (2026-02-28)

### Refactor

- rename network_utility agent to netutils (NetUtils) (#870)

## 0.2.29 (2026-02-27)

### Feat

- add agent-weather and agent-petstore to helm chart (#869)

## 0.2.28 (2026-02-27)

### Feat

- **aigateway**: deterministic Webex message and Helm task config

### Fix

- linter err
- more gracefully handle error such as context too large, recursion limit etc
- correctly handle final output when recursion limit is hit
- **multi-node**: execution plan parsing, user email propagation, form submission, and SSO config
- **ui**: prevent HITL form from reappearing after workflow completion
- **ci**: pin deps/build stages to BUILDPLATFORM in caipe-ui Dockerfile
- **build**: regenerate uv.lock to sync with pyproject.toml

### Refactor

- **helm**: symlink task_config.yaml from charts data and remove list_self_service_tasks tool

## 0.2.27 (2026-02-26)

### Feat

- make skill-templates independent of caipe-ui.enabled (#836)
- **victorops**: Add Agent victorops aka Splunk On-call (#858)

## 0.2.26 (2026-02-26)

### Feat

- **agent**: add network utility agent and MCP server (#855)
- **rag-server**: add MCPAuthMiddleware to enforce auth on /mcp routes

### Fix

- **deps**: upgrade cnoe-agent-utils to 0.3.11 (#860)
- **build**: add retry logic to npm install for transient registry errors (#859)

## 0.2.25 (2026-02-25)

### Feat

- handle existing LLM keys, persist form on refresh, show selections

### Fix

- correctly send final structured output to the UI when user input is required
- **rag**: resolve RBAC crash in ontology agent reverse proxy
- **streaming**: use supervisor final message for final_result artifact
- **aigateway**: remove extraneous f-string prefix in tools.py

## 0.2.24 (2026-02-25)

### Feat

- **ui**: add interactive changelog viewer to System Settings dialog (#851)

### Fix

- **ui**: persist skill_content and related fields on skill creation (#852)

## 0.2.23 (2026-02-25)

### Fix

- **ui**: auth redirect, loading spinner, theme visibility, and session resilience (#850)
- **supervisor**: repair streaming failures from json scoping and orphaned tool calls (#842)

## 0.2.22 (2026-02-24)

### Feat

- Support comma-separated OAUTH2_CLIENT_IDS for cid validation (#849)
- **rag**: add batch job status endpoint for efficient datasource polling (#845)
- **ui**: add response field to CAIPEAgentResponse for form chat text
- **tools**: add terraform_fmt tool and fix filesystem state consistency
- set USE_STRUCTURED_RESPONSE true by default (#840)
- **single-node**: add structured response support and ResponseFormat tool notifications

### Fix

- **ui**: default canViewAdmin to true for pre-upgrade JWT sessions (#837)
- **docker-compose**: remove jarvis from all-agents profile (#848)
- get rid of ResponseFormat as sonnet sometimes uses this instead and breaks
- make it work with newer claude models that do not support prefilling
- **agent**: make CAIPEAgentResponse response field optional
- **tools**: use correct InjectedState import for tool_result_to_file
- **agent**: emit execution plan when write_todos is called
- **agent**: fix execution plan bug
- **github-mcp**: make octicon icons optional for Go embed
- **ui**: add missing A2AEvent type import to ChatPanel
- **single-node**: fix ResponseFormat parsing, HITL handler, and UI overflow
- **ui**: restore agent-config types from skills builder feature
- **ui**: sync agent-config store and types with main
- **ui**: restore agent-builder components lost during merge
- **chart**: remove self-service env defaults that override envFrom

## 0.2.21 (2026-02-23)

### Feat

- **ui**: replace previewMode with configurable envBadge (#834)
- **ui**: make admin dashboard read-only for non-admin authenticated users (#833)
- **ui**: env-configurable personalization defaults, new themes, and unified settings menu (#832)
- **ui**: refactor Create Workflow into Skills Builder Editor with skills in helm chart (#829)

### Fix

- **ui**: team-shared conversations not appearing for team members (#831)
- **confluence-ingestor**: track document_count per ingested page (#818)

## 0.2.20 (2026-02-20)

### Feat

- **ui**: auto-enable follow_external_links when sitemap mode is selected
- **ui**: show follow_external_links option for sitemap crawl mode
- **webloader**: show sitemap URL in job success message
- **chart**: add agent-weather dependency and remoteAgent bypass for single-node
- **ui**: add support to UI's admin page for prometheus metrics dashboard (#826)
- **ui**: add WORKFLOW_RUNNER_ENABLED feature flag (#823)
- **github-mcp**: add invite_user_to_org tool and parameterize task config

### Fix

- **webloader**: don't append /sitemap.xml when URL already points to a sitemap
- **webloader**: disable Scrapy telnet console
- **webloader**: propagate CloseSpider reason to job error message
- **webloader**: fail with clear error when sitemap URLs point to different domain
- **webloader**: detect canonical domain from sitemap URLs
- **webloader**: add robust sitemap discovery with fallback chain
- **webloader**: fix sitemap discovery for subdirectory paths
- **ci**: strip pre-release suffix before version arithmetic in helm-pre-release
- **ui**: clear stale HITL form after submission
- **rag**: resolve web-ingestor tight loop caused by reload interval mismatch (#817)
- **ui**: show amber RAG Disconnected badge when only RAG is offline (#821)
- **task-config**: handle empty repos and fix step numbering in deploy task
- persist user input on the UI after refresh or page return
- **rag**: prioritize JWT auth over trusted network (#815)
- **confluence-ingestor**: accept CONFLUENCE_API_TOKEN as fallback for CONFLUENCE_TOKEN (#814)

### Refactor

- **webloader**: add job_id prefix to all spider log messages
- move field_values sorting from code to task config

## 0.2.19 (2026-02-18)

### Feat

- **ui**: add reload interval UI and help popup for RAG ingest
- **rag**: add per-datasource reload interval for webloader
- **ui**: support comma-separated OIDC_GROUP_CLAIM values
- **ui**: remove X-Identity-Token header from RAG proxy
- **rag**: implement tiered groups resolution with Redis caching
- **rag**: add userinfo endpoint support for fetching user groups

### Fix

- **supervisor**: send supervisor synthesis as final_result in single sub-agent scenario (#809)
- **github**: fix streaming
- **github**: fix github mcp
- **remote-a2a**: add remote weather agent and add github mcp
- **ui**: restore HITL resume flow for form submissions
- **a2a**: construct resume Command from plain text form submissions
- **prompt**: add final_answer_instructions to platform system prompt template
- sync UI code with main and regenerate webex mcp uv.lock
- resolve merge conflicts with main (RAG proxy comments, auth-config docs)
- **rag**: fix lint issues in rbac.py

### Refactor

- **rag**: always fetch userinfo for user claims (email + groups)

## 0.2.18 (2026-02-17)

### Feat

- **single-node**: add user email context, fix recursion limit, and fix webex mcp
- **rag-ui**: add 'Restrict to this page' button for SPA tab scraping
- Return trace_id to clients for Langfuse feedback (#805)

### Fix

- **rag**: improve web crawler with streaming ingestion, redirect handling, and JS rendering
- **ui**: replace hardcoded CAIPE references with configurable appName (#806)
- mongodb sts can NOT rely on labels that are dependent on the chart version (#804)

## 0.2.17 (2026-02-13)

### Fix

- manual release is missing ci-caipe-ui
- lint err
- don't call _get_final_content if using response_format_tool
- ui to render field_options correctly with the new structured final output using field_values
- Merge origin/main into feat/add-structured-response-v2

## 0.2.16 (2026-02-13)

### Feat

- **ui**: track message sender identity for shared conversations
- **ui**: show user first name instead of 'You' in chat messages
- introduce new was_task_successful and depricate request_user_input if USE_STRUCTURED_RESPONSE is true
- add support for USE_STRUCTURED_RESPONSE where LLM uses structured response tool call as its final output
- **a2a**: add source agent tracking for sub-agent message grouping
- agent resilience, registry exclusions, and infra improvements
- **rag-stack**: add PodDisruptionBudgets for Milvus components
- add agentgateway helm chart under ai-platform-engineering
- introduce new was_task_successful and depricate request_user_input if USE_STRUCTURED_RESPONSE is true
- add support for USE_STRUCTURED_RESPONSE where LLM uses structured response tool call as its final output
- **ui**: add configurable favicon via NEXT_PUBLIC_FAVICON_URL
- **ui**: rename Agentic Workflows to Skills and add icon customization
- **rag**: add slim ingestors variant and consolidate CI matrix
- **github**: add private key path passthrough and clean up env example
- **github**: add token sanitization to prevent credential leakage
- **github**: add GitHub App token auto-refresh for MCP authentication
- **ui**: add user insights page, enhanced admin dashboard, and chat performance improvements
- **ui**: add crash recovery with interrupted message detection and task polling
- **ui**: add copy-to-clipboard for access token and ID token in user menu
- **ui**: add conversation archive with soft-delete, restore, and auto-purge
- **ui**: add silent token refresh and dismiss persistence for expiry guard
- **ui**: persist chat messages and A2A events to MongoDB for cross-device sync
- **ui**: sync UI personalization to MongoDB for cross-device persistence
- **ui**: implement team management — view details, manage members, delete teams
- **ui**: add branding env vars to docker-compose and helm values
- **ui**: replace NEXT_PUBLIC_ with runtime config via /api/config
- **rag-server**: reduce Docker image size by making HuggingFace optional
- **helm**: simplify rag-server config to use generic env map
- **embeddings**: add LiteLLM proxy support for embeddings
- **auth**: add X-Identity-Token header support for ID token claims extraction
- **ingestors**: add status messages for JavaScript rendering mode
- **build**: add Playwright/Chromium support to ingestors image
- **ingestors**: add backwards compatibility for deprecated settings fields
- **ui**: display document and chunk metrics in ingest view
- **server**: add chunk count tracking and cleanup utility
- **ingestors**: integrate Scrapy loader into web ingestor
- **common**: add ScrapySettings model and job metrics tracking
- **ingestors**: add Scrapy-based web loader infrastructure
- **a2a**: emit per-task tool notifications for deterministic workflows
- simplify deployment to single-node deep agent architecture

### Fix

- **ui**: auto-select conversation and preserve messages on tab switch
- resolve lint errors in dedup tests and agent_executor
- **streaming**: extend dedup to _handle_task_complete and add comprehensive tests
- **streaming**: deduplicate sub-agent content in single-agent scenarios
- merge conflict
- add default env var for supervisor with new USE_STRUCTURED_RESPONSE
- **ui**: correct WorkflowHistoryView import path after skills rename
- **lint**: remove unused imports and variables in test files
- **docs**: add gitlab agent to sidebar navigation
- add default env var for supervisor with new USE_STRUCTURED_RESPONSE
- **slack-ingestor**: always update datasource timestamp to prevent infinite sync loops
- replace hardcoded AIGATEWAY_SERVER_URL with env var reference
- **build**: include multi-agent tests in make test target
- **test**: correct env var scoping in registry exclusion tests
- do not trust llm gateway-api is not a chart
- agentgateway requires gateway-api
- need to install agentgateway CRD
- correct repo
- try
- v2.2.0-main does not exist despite being referenced in docs
- **ui**: use upsert in favorites API to avoid 404 race condition
- **ui**: update remaining Agentic Workflows references to Skills
- **web-ingestor**: use consistent HTTP error formatting for sitemap and robots.txt failures
- **web-ingestor**: report HTTP errors for sitemap, robots.txt, and batch ingestion to job status
- uv lock
- **docs**: escape email in MDX to fix Docusaurus build
- **github**: remove unused timezone import to fix lint error
- **agent-github**: add langchain as direct dependency for langfuse tracing
- **ui**: resolve TypeScript build failure in ChatPanel
- **ui**: fix session expiry by enabling token refresh on updateSession
- **ui**: update stale messages in MongoDB after streaming completes
- **ui**: improve code block rendering for shell commands
- **ui**: respect user scroll position during agent streaming
- **ui**: prevent long text from overflowing chat messages to the right
- **ui**: resolve infinite re-login loop when session is expiring
- **ui**: remove title prop from Lucide icons to fix TypeScript build error
- **ui**: sync follow-up messages across devices and fix event accumulation
- **ui**: add Safari SSE streaming polyfill for A2A compatibility
- **ui**: sync conversation deletions across browsers and devices
- **ui**: sync conversation ID between client and MongoDB to fix share dialog
- **ui**: storage mode always showing localStorage on client
- **ci**: fix CAIPE UI Tests workflow and Jest tests
- **ui**: runtime env script order and storage-mode re-check
- **docs**: resolve MDX compilation and broken link errors breaking GH Pages build
- **lint**: remove unnecessary f-string prefix
- **lint**: remove unused imports and delete scripts folder
- **ingestors**: correct metadata structure for source URL in documents
- **a2a**: prevent primary stream crash on nameless ToolMessages
- **ui**: restore entrypoint.sh env-config.js for runtime env injection
- **ui**: use dynamic getConfig for caipeUrl in health hook
- **ci**: resolve ruff lint errors and duplicate TypeScript declarations
- **agents**: fix github subagent and single node deep agent
- **rag**: fix rag tool initialisation
- **agents**: fix webex, backstage, jira agents
- **ui**: remove container healthcheck and align RAG_SERVER_URL usage
- **ui**: replace build-time env vars with runtime PublicEnvScript injection
- **ci**: ensure caipe-ui builds on RC tag pushes

### Refactor

- **ui**: remove ENABLE_SUBAGENT_CARDS flag and Agent Stream card boxes
- **ui**: remove localStorage cache in MongoDB mode, use upsert for messages
- **ui**: move Personal Insights to user menu, replace Recent Prompts with Skill Usage
- **ui**: rename Agentic Workflows to Agent Skills
- **ui**: use Palette icon for UI Personalization button
- **ui**: rename Settings to UI Personalization with Paintbrush icon
- **ui**: replace /api/config fetch with window.__APP_CONFIG__ injection
- **ui**: replace useConfig() with getConfig()/config imports

### Perf

- **ui**: fix scroll performance, A2A Debug rendering, and history re-renders

## 0.2.15 (2026-02-05)

### Feat

- **ui,rag**: add RAG disable feature and trusted network config
- **ui**: add version display in System Status popover
- **gitlab**: add MCP server config and comprehensive documentation
- **rag**: add JWT authentication and RBAC documentation
- **ci**: enhance CAIPE UI test coverage reporting in PRs
- **ci**: add CAIPE UI test automation and fix test mocks
- **ui**: add mongodbEnabled to config system
- **docker**: add CAIPE UI service with MongoDB integration
- **docker**: add CAIPE UI with MongoDB profiles and enable flag
- **ui**: compress streaming events in A2A timeline views
- **ui**: redesign A2A timeline with trace view and fix workflow history thumbnail
- **ui**: move workflow history to right panel and improve UX
- **ui**: add A2A timeline view and fix workflow thumbnail markdown rendering
- **charts**: integrate MongoDB and update CAIPE UI configuration
- **charts**: add ingress redirect template for domain migration
- **charts**: add MongoDB Helm subchart for CAIPE UI persistence
- **ui**: add dedicated workflow history page
- **ui**: back button now opens workflow history panel
- **ui**: add CAIPE spinner overlay while saving workflow
- **ui**: migrate favorites from localStorage to MongoDB
- **ui**: add structured user input form rendering
- **backend**: add UserInputMetaData artifact support for request_user_input
- **ui**: improve OIDC info dialog and fix auth initialization
- **ui**: add AuthGuard to all knowledge-bases and admin pages
- **ui**: disable admin tab when MongoDB is not configured
- **ui**: restore three-panel chat layout with MongoDB persistence
- **agentic-workflows**: enhance execution output with fullscreen and copy features
- add favorites and edit functionality to quick-start templates
- move 'Run in Chat' to quick-start dialog
- add 'Run in Chat' button to agent builder
- **sidebar**: implement hover-based visibility for share and delete buttons
- **sidebar**: add resizable width, truncation indicator, and dynamic text expansion
- add agent builder UI and MongoDB chat history improvements
- **ui**: add admin dashboard, teams management, and various UI improvements
- **ui**: make agents selection optional in Use Case Builder
- **ui**: implement share button and dialog for conversations
- **ui**: integrate MongoDB persistence with chat UI
- **ui**: implement complete MongoDB persistence with Next.js API routes
- **dev**: add mongo-express web UI for MongoDB management
- **backend**: integrate chat API routes with FastAPI server
- **ui**: complete Phase 3 - share dialog and status UI
- **ui**: implement Phase 3 core - UUID routing and MongoDB integration
- **backend**: implement Phase 2 - audit logging and notifications
- **backend**: implement MongoDB chat history backend (Phase 1)
- **dev**: add MongoDB service to docker-compose.dev.yaml
- **rag**: ui improvements for rbac, configs and readme
- **rag**: auth rework for user and ingestor
- **ui**: unified connection status popup
- **ingestor**: add OAuth2 client credentials authentication support
- **auth**: implement JWT validation for RAG server with multi-provider support
- **ui**: add rag rbac to knowledge-bases tab
- **ui**: add ingestor type availability logic; fix icons
- **ui**: add back ingestors section
- **task-config**: update self service tasks
- **streaming**: enable subagent token streaming
- **task-config**: initial task config implementation
- **ui**: add manual refresh token button to test token validity
- **ui**: display refresh token metadata in OIDC token dialog

### Fix

- **ui**: improve Docker build network resilience for npm ci
- lint/js issues
- **rag**: crash when collectiond doesnt exist
- some layout fixes; node details card
- graph view now works
- **ui**: knowledgebases page now defaults to search
- **ui**: search bar improvements
- **ui**: redesigned datasources section
- **gitlab**: escape curly braces in prompt configs and set INFO log level
- **lang**: fix splunk specific gitlab instance
- **code**: lint
- **rag**: resolve linting errors in RAG server restapi
- **ui**: implement hybrid auth for RAG proxy with JWT Bearer and OAuth2Proxy fallback
- **ui**: restore TypeScript strict mode with pragmatic relaxations
- **ui**: resolve TypeScript compilation errors for production build
- **ci**: resolve syntax error in CAIPE UI tests workflow
- **ui**: add ZoomIn and ZoomOut imports to A2A timeline
- **ui**: add missing compression function and zoom imports
- **ui**: add missing imports for A2A timeline modal
- **ui**: resolve React hooks order violation in ChatUUIDPage
- clean-up
- replace Azure OpenAI endpoint with generic example
- replace Outshift-specific URLs with generic examples
- **ui**: extract run ID from wrapped API response
- **ui**: make handleEvent async to await workflow saves
- **ui**: ensure workflow saves complete before navigation
- **ui**: ensure workflow status updates even when navigating away
- **ui**: improve workflow history UX and handle incomplete runs
- **ui**: parse wrapped API response for favorites
- **ui**: resolve workflow execution history not saving due to React closure issue
- **ui**: handle undefined favorites in MongoDB response
- **ui**: extract UserInputMetaData from DataPart in A2A artifacts
- **ui**: bind fetch to window context to prevent illegal invocation error
- **ui**: update agent card endpoint to non-deprecated URL
- **ui**: improve chat input box positioning and width
- ensure input textbox remains visible and accessible
- resolve chat panel scroll and context panel persistence issues
- remove ... icon
- **ui**: improve chat history text truncation when sidebar resizes
- **ui**: feedback popover opens for both thumbs up and down
- **ui**: improve feedback button UX and fix icon spacing
- **ui**: persist conversation titles to MongoDB on auto-generation
- **ui**: prevent SSR API calls causing crash loop
- **ui**: hide share button for legacy localStorage conversations
- **ui**: resolve new conversation creation and TypeScript build errors
- **ui**: resolve TypeScript build errors for MongoDB integration
- **ui**: improve UX for sharing legacy conversations
- **ui**: resolve infinite authorization loop with automatic session recovery
- **ui**: resolve AuthGuard infinite loading on login
- **ui**: add graceful error handling for legacy conversations
- **ui**: new chat button now creates MongoDB conversations
- **ui**: render share dialog as centered modal overlay
- **ui**: sync conversations to MongoDB on creation
- **ui**: center share dialog on screen
- **ui**: auto-initialize users and improve share search
- **ui**: update API routes for Next.js 15+ async params
- **ui**: correct authOptions import path in api-middleware
- **backend**: make MongoDB lifespan accept app parameter
- **backend**: correct FastAPI/Starlette app mounting order
- **ui**: add API proxy rewrites for MongoDB chat backend
- **backend**: properly mount chat API routes on FastAPI
- **ui**: redirect /chat to UUID-based conversation URL
- remove webui from build
- clear results in search
- **ui**: better UX for knowledge base page
- **ui**: fix the flickering kb page
- remove old webui references
- linting issues
- **rag**: use upsert instead of add
- lint
- **rag**: add missing lock file
- **ui**: add permission tooltip with new user-info endpoint
- **rag**: cleaner response for user-info endpoint
- **ui**: get permissions directly from RAG server
- **webex**: fix mcp tools in webex agent and update tasks
- **create-github-repo**: fix mcp tools and add backstage step
- **ui**: prevent AuthGuard from getting stuck on 'Verifying authorization'

### Refactor

- **charts**: reorganize MongoDB under caipe-ui context
- **ui**: complete branding update for login/logout pages
- **ui**: update branding to Multi-Agent Collaboration & Workflow Automation
- remove all MongoDB integration from entire project

### Perf

- **ui**: optimize A2A trace view timeline scaling and tick spacing
- **ui**: reduce workflow history auto-refresh from 3s to 15s

## 0.2.14 (2026-01-28)

### Fix

- **ui**: resolve TypeScript build error blocking CI

## 0.2.13 (2026-01-28)

### Feat

- **ui**: add user context tracking to backend messages
- **ui**: add Popover component
- **ui**: display integration tags in connection status
- **ui**: enhance user menu and connection status
- **ui**: add horizontal scroll to markdown tables
- **ui**: add advanced theme settings with gradient controls
- **ui**: move Tech section to user menu as 'About'
- **ui**: apply gradient themes across all pages, icons, and widgets
- **ui**: add gradient theme selector with 5 theme options
- **ui**: implement @mention autocomplete for agent selection
- **ui**: move stop button to text input area
- **ui**: enhance textbox focus state with stronger visual feedback
- **ui**: replace textarea with auto-growing textarea component
- **ui**: add ui path routing
- **tests**: add Make targets for CAIPE UI tests
- **ui**: make OIDC refresh token support optional and gracefully degrade
- **ui**: implement OIDC refresh token support for seamless authentication
- **docs**: add CAIPE UI section to sidebar navigation
- **makefile**: add documentation site targets
- **ui**: enhance A2A debug panel with execution plan and full event streaming
- **ui**: implement runtime configuration and enhance SSO user menu
- **helm**: add external secrets and configmap support for caipe-ui
- **usecases**: add edit functionality and fix placeholder detection
- **ui**: migrate to @a2a-js/sdk and improve streaming UX
- **ui**: add retry button to regenerate responses
- **a2a**: improve streaming reliability and UI performance
- **helm**: add caipe-ui subchart with ingress support
- **ui**: add RAG integration, layout settings, and dark mode improvements
- **helm**: add caipe-ui subchart with ingress support
- **ui**: add download button for A2A events in debug panel
- **ui**: persist tool notifications with collapsible history
- add Docker build targets and fix nginx.conf
- **ci**: add CAIPE UI Docker build workflow and reorganize Dockerfile
- add caipe-ui make targets for running the UI
- **ui**: add visual feedback to JSON copy button in A2A debug
- **ui**: add Linux logo and fix favicon
- **ui**: update IntegrationOrbit with official full-color logos
- **ui**: add GitHub PR Review use case with input form
- **ui**: use full-color original SVG logos in task list
- **ui**: add official agent logos to task list and agent selector
- **ui**: implement agent-forge features - feedback, copy, tasks, agent selection
- **ui**: persist A2A events, tasks, and output to localStorage
- **ui**: implement per-conversation streaming state
- **ui**: add Tasks tab to ContextPanel for execution plan display
- **ui**: expand streaming output by default during streaming
- **ui**: full-width two-panel layout for login and logout
- **ui**: add integration orbit animation to logout page
- **ui**: update integration logos with accurate SVG icons
- **ui**: disable panel resizing on Use Cases tab
- **ui**: add resizable panels for sidebar, chat, and context
- **ui**: show descriptive tool notifications with wrench emoji
- **ui**: show connected URL in status indicator
- **ui**: persist chat history to localStorage
- **ui**: add branded loading screen component
- **ui**: add logout page and improve auth flow
- **ui**: add font options and settings panel
- **ui**: make OIDC group claim configurable
- **ui**: add OIDC SSO with group-based authorization
- add caipe-ui using a2ui, copilotkit

### Fix

- **ui**: prevent session expiry flickering between modal and redirect
- **ui**: convert connection status tooltip to popover
- **ui**: font family selection now applies correctly
- **ui**: rename 'Advanced' to 'OIDC Token' in user menu
- **ui**: use CSS variables for background gradients and gradient text
- **ui**: apply gradient theme CSS variables to components
- **ui**: completely disable resume auto-scroll button during streaming
- **ui**: prevent auto-scroll button from appearing during fast streaming
- **ui**: remove outer box highlight on textarea focus
- **ui**: move copy and retry buttons to bottom of user messages
- **ui**: align message padding with input section
- **docs**: fix broken link in a2ui-integration.md
- **tests**: fix failing Jest tests and add fetch mock
- **ui**: handle SSO token expiry gracefully with user notifications
- **ci**: handle docs-only changes gracefully in CAIPE UI workflow
- **docs**: resolve MDX build errors and broken links
- **ui**: add display content for empty task and status events
- **gitlab**: remove unused import
- **docker**: remove extra code
- **helm**: fix small issues with backstage ingestor docker compose and code
- correct condition
- **caipe-ui**: bump chart version
- **ui**: resolve all TypeScript build errors for CI
- **ui**: add mongodb dependency and fix TypeScript type errors
- **a2a**: detect [FINAL ANSWER] marker to send final_result artifacts
- **ui**: always store task and tool events for Tasks panel
- **ui**: treat complete_result as internal artifact, not final result
- **ui**: change caipe-ui port to 3000
- **ui**: read OIDC config from .env file
- **ui**: cleaner code block styling without text highlighting
- **ui**: improve code block detection and add copy button
- **ui**: fix multiple TypeScript errors for production build
- **ui**: provide initial value for useRef in tooltip
- **ui**: update PanelSize API - use asPercentage instead of percentage
- **ui**: properly handle status-update events to mark message final
- **ui**: properly handle complete_result with full content replacement
- **ui**: always append streaming chunks, only replace for final result
- **ui**: handle A2A message events for complete content streaming
- **ui**: handle partial_result artifact as complete content
- **ui**: remove tool notification badges from chat panel
- **ui**: clear A2A events when deleting active conversation
- **ui**: use A2A append flag for proper streaming behavior
- **ui**: replace content for complete_result artifacts
- **ui**: prevent duplicate content and auto-complete tasks
- **ui**: improve tool notifications in chat panel
- **ui**: improve SSO redirect and integration orbit logos
- **ui**: improve Backstage logo to fit container
- **ui**: change ArgoCD logo background to dark color
- **ui**: resolve hydration mismatch in IntegrationOrbit
- **ui**: add missing lib/ files and fix UUID generation for A2A
- **ui**: auto-submit message when selecting a use case
- **ui**: match agent-forge feedback button behavior exactly
- **ui**: place contextId inside message for A2A conversation continuity
- **ui**: prevent raw JSON toggle from closing A2A event card
- **ui**: pass thread ID for multi-turn conversations & fix user attributes
- **ui**: blend animation and panel backgrounds seamlessly
- **ui**: add turbopack config for Next.js 16
- **ui**: update resizable panels to use v4 API
- **ui**: pass user name and email from OIDC profile to session
- **ui**: make font preview section respond to selection
- **ui**: fix settings panel not showing
- **ui**: fix React child rendering error in ContextPanel
- **ui**: add spin animation and improve login loading screen
- **rbac**: add email validation, audit logging, role validation, and improve documentation

### Refactor

- **ui**: update tech stack to show only actively used technologies
- **ui**: remove [FINAL ANSWER] logic, display streamed content as-is
- **ui**: simplify ContextPanel with Tasks as default tab

### Perf

- **ui**: optimize chat performance and prevent OOM issues

## 0.2.12 (2026-01-22)

### Feat

- **spec-kit**: add Cursor rules for CAIPE development
- initialize Spec Kit at repository root

### Fix

- **supervisor**: synthesize results from all sub-agents in multi-agent queries

## 0.2.11 (2026-01-21)

### Feat

- add authn to rag-stack chart
- add role/userinfo to ui, fix ingestor type not availalbe
- add RBAC to rag server endpoints

### Fix

- extract context_id from supervisor message metadata for conversation continuity
- **ci**: make helm rc bump to directly trigger pre-release push
- **ci**: force re-registration of workflow_run trigger
- lint issues
- add missing models
- do not include agentForge CI in the finalise and fix arm64 build

## 0.2.10 (2026-01-20)

### Fix

- **redis**: use Recreate strategy with persistent volumes

## 0.2.9 (2026-01-20)

### Feat

- **supervisor**: add [FINAL ANSWER] marker to filter thinking messages
- **tools**: consolidate utility tools into utils/agent_tools
- **tools**: add git auth support and beads-github sync
- **platform-engineer**: integrate new utility tools into deep agent
- **tools**: add utility tools for git, grep, wget, curl, glob, and memory
- **aws**: add tracing configuration and disable A2A framework tracing
- **rag**: Refactor Confluence ingestor to use json-based configuration
- **gitlab**: add GitLab agent configuration and minimal prompt config
- **gitlab**: add GitLab agent
- **beads**: add A2A Streaming Improvements epic and tasks
- add beads (bd) issue tracking system
- use new helm chart GHCR oci://ghcr.io/cnoe-io/charts/* so it does not collide with legacy charts
- new release pipeline to automate helm version and image tagging
- **confluence-rag**: Implement confluence rag ingestor v2

### Fix

- **executor**: prevent duplicate responses when sub-agent completes
- **supervisor**: add prominent [FINAL ANSWER] instruction to core constraints
- **tests**: update tool tests to match string-based return API
- updates
- wrong helm chart version committed by accident
- use URL token injection for git authentication
- update comment
- **a2a**: prevent streaming output duplication
- **rag**: Set correct RELOAD_INTERVAL for datasource refresh
- **gitlab**: remove unused task
- **tracing**: configure LangGraph model with agent name for proper observations
- **rag**: Allow discovery with fewer entities
- inf loop bug; hf api token

### Refactor

- **executor**: simplify agent_executor and add streaming fix
- **executor**: remove unused routing logic and dead code
- **a2a**: remove redundant import aliases
- move git tools to utils with GitHub/GitLab support
- **tools**: move git_* tools to GitHub agent
- **tools**: move memory tool to separate PR

## 0.2.8 (2025-12-22)

### Feat

- **helm**: make rag prompt configurable

### Fix

- **docker-compose.yaml**: add rag_web_ingestor
- **helm**: make grafana dashboard label configurable
- rag tool and prompt optimizations
- critical fix for ingestor

## 0.2.6 (2025-12-16)

### Feat

- add langfuse to agent ontology
- **prompts**: make analyze_query mandatory for all queries
- **agents**: add SOPs, table formatting, and context scoping to Confluence, PagerDuty, AWS
- **splunk**: add Splunk Cloud Platform MCP log search integration
- **langmem**: add proactive pre-flight context check to supervisor
- **langmem**: add centralized LangMem utility with observability
- **multi-agents**: add langmem dependency for supervisor
- **agents**: implement comprehensive context management and error recovery
- **agents**: add intelligent tool output truncation for context management
- **github-agent**: add gh CLI tool for workflow log retrieval and debugging
- **prompts**: add GitHub Actions log retrieval from URLs
- **agents**: add MCP tool error handling to prevent A2A stream closure
- **prompts**: add GitHub agent formatting SOP and context awareness

### Fix

- clean-up
- reconcile
- **docker-compose.dev.yaml**: revert to stable
- add MAX_SEARCH_RESULTS and WARN_SEARCH_RESULTS for argocd agent
- neo4j port
- rag image
- docker-compose fix
- minor bugfix; docker-compose fixes
- accept/reject buttons api in UI
- argocd ingestor additional id keys
- content too large err, return 400 if no ontology; better batching
- better err handling for ontology agent
- explicit rag reference instructions
- **ci**: add uv to PATH in lint workflow
- **prompts**: escape curly braces in JSON examples for Python format()
- add analyze_query as llm query
- add analyze_query as llm query
- updates
- **langmem**: fix API call and prevent orphaned tool calls
- **supervisor**: respect ENABLE_STREAMING env var
- **streaming**: resolve Queue is closed race condition and improve error handling
- **agents**: improve error parsing for TaskGroup and async errors
- **prompts**: make RAG lookup conditional
- **supervisor**: improve orphaned tool call recovery UX
- **prompts**: remove biased examples from GitHub Actions debugging SOP
- **supervisor**: fix ToolMessage and SystemMessage imports
- **agents**: update to non-deprecated create_agent API
- **agents**: correct LangMem API usage and import order
- **github-agent**: add GH_TOKEN environment variable for gh CLI authentication
- **docker-compose.yaml**: add RAG_SERVER_URL

### Refactor

- **prompt**: reconcile jarvis prompt with deep_agent optimizations
- **prompt**: make source citation generic and add prompt chaining
- **prompt**: make agent prefixes generic in supervisor prompt
- **prompts**: replace analyze_query with [Agent] prefix format
- **agents**: use LLMFactory for LangMem summarization

## 0.2.5 (2025-12-12)

### Feat

- webui ingest view now supports pagination
- **docs**: add development guide
- add github ingestor
- move confluence to use official mcp image by default in helm
- **build**: add test-agent-argocd target for agent unit tests
- **confluence**: apply sooperset/mcp-atlassian to production docker-compose
- **confluence**: replace custom MCP server with sooperset/mcp-atlassian
- **aws**: improve ECR URL parsing and repository search
- **supervisor**: add AWS agent for Kubernetes debugging
- **jira**: enhance MCP error handling and epic linking workflow
- auto-inject current date into ALL agent queries globally
- **aws**: auto-inject current date into every query
- **aws**: add smart date usage - only fetch dates when actually needed
- **aws**: add smart namespace auto-discovery for kubectl operations
- **aws**: add kubectl logs support and documentation
- **aws**: add Phase 7 - Kubernetes pods status to EKS health check SOP
- **aws**: add EKS kubectl tool with temporary kubeconfig management
- **aws**: add comprehensive EKS cluster health check SOP
- **aws**: broaden planning workflow triggers beyond 'all' queries
- **aws**: implement planning mode with reflection sub-agent
- upgrade langchain to 1.x for deepagents compatibility
- **aws**: integrate deepagents for context management and auto-offloading
- **aws**: prompt agent to ask for account when not specified
- **docker**: add AWS CLI, kubectl, jq and multi-account configuration
- **supervisor**: update AWS agent routing to support all services and cost queries
- **aws**: enhance AWS agent system prompt for multi-account and cost queries
- **aws**: add AWS CLI tool with cross-account support and reflection capabilities
- add reflection and autonomous retry to supervisor and jira agents
- **jira**: add explicit update verification and confirmation workflow
- **jira**: add intelligent field handling and fallback for custom fields
- **jira**: add filter management tools and board creation workflow
- **jira**: add comprehensive MCP tools and enhanced security
- **docker**: add section headers and slim transport configuration
- **docker**: refactor docker-compose.dev.yaml for better configurability
- **agent-forge**: improve build workflow and add local build tooling
- **supervisor**: add ambiguous terms clarification for multi-agent queries
- **jira**: add reflection and auto-retry strategy for failed searches
- **jira**: add get_epic_issues tool and improve agent reliability
- **jira**: add read-only mode, mock responses, and improve error propagation
- **jira**: implement dynamic field discovery and schema validation
- add grafana dashboard to helm chart
- add grafana-dashboard
- rag intertation with supervisor
- also update docker-compose files in main dir to volume mount
- just some more logging
- bump charts
- make all sub-agent prompts configurable
- also enable metric from each sub-agent
- default metric to false and use global with helper
- add prometheus metrics support

### Fix

- remove unused var
- update .gitleaksignore
- remove agent_rag pyproject/uv
- lint issues
- remove redis bloom filter logi
- remove kw queries
- docker-compose updates
- webloader ingestor bugs
- webex ingestor bugs
- default sync interval, github graph entity id keys
- argocd ingestor bug
- ingestor sleeping logic, better entity type format
- neo4j entity_type bug, consume results
- graphrag async logic bug
- **aws**: include tools.py and agent_strands.py in Docker builds
- **aws**: use relative imports in agent_executor
- lint & icons
- ui bugs, neo4j bugs, langchain issues
- dissapearing relations
- confluence mcp requires TRANSPORT: "streamable-http" to work
- make agent-confluence use the same env var names as official confluence mcp
- correct chart version bump
- **uv.lock**: update agent_github
- add rag-stack subchart import-values back for automatic cm rendering
- **jira**: return error JSON instead of raising exceptions in MCP tools
- **agent-runtime**: add jwt deps for github/webex/weather and petstore build arg
- **jira**: resolve pydantic default handling in MCP tools
- **argocd**: add utils as explicit dependency with proper versioning
- **deps**: align utils dependencies with workspace and regenerate argocd lock
- **build**: include agent uv.lock files in Docker builds for reproducible builds
- **build**: use --locked flag to enforce committed lock files in Docker builds
- **build**: improve agent test isolation and prevent MCP test conflicts
- **jira-mcp**: update tests to match error JSON return behavior
- **argocd-mcp**: use uv run python for test execution
- **argocd-mcp**: add dependency installation to test target
- **komodor**: remove from system prompt
- **confluence**: remove healthcheck from mcp-confluence in dev compose
- **confluence**: remove Authorization header for sooperset/mcp-atlassian HTTP mode
- **supervisor**: remove Komodor references from platform engineer
- **jira**: replace exceptions with error JSON in comments.py
- **jira**: replace exceptions with error JSON in issues, boards, sprints
- **jira**: prevent duplicate issue creation on epic linking failures
- update langchain import for langchain 1.x compatibility
- add missing prometheus_client dependency to weather and template agents
- add missing AGENT_NAME build arg for agent-petstore
- **supervisor**: remove get_current_date requirement for AWS queries
- **aws**: prevent agent from hallucinating resource names
- **aws**: correct reflection sub-agent key from 'prompt' to 'system_prompt'
- **aws**: add checkpointer to deepagents for state persistence
- **aws**: remove StateBackend explicit initialization in deepagents
- **aws**: remove 'default' profile option from AWS CLI tool
- make to do more resilient by handling duplicate icon issue
- correctly handle different llm content types (list for aws bedrock, str for azure openai)
- bump Chart.yaml
- Update Chart.lock
- bump rag-stack dependency
- answer format for rag
- Update pre-release-a2a-rag
- Update pre-release-a2a-rag.yml
- **jira-mcp**: remove unused imports and f-string prefix
- **jira**: add browse_url to all MCP tool responses
- **jira**: use actual Jira base URL instead of placeholder in links
- **jira**: resolve circular import and fix check_read_only function
- **jira**: remove unused imports in test files
- **ci**: add QEMU setup for multi-platform Docker builds
- updates
- **a2a**: restore max_retries=1 default and tool error tracking
- bump caipe chart version
- disable auto-eval
- bump Chart.yaml
- update agent-ontology chart
- bump chart
- rag chart for v2 ingestor
- update slack ingestor readme
- remove old code, ui bug fixes
- add/update readmes
- remove agent_rag (deprecated)
- rag tool optimisations, crash fix
- lint fixes
- update .gitleaksignore
- GH workflow
- search optimisations, fixed tests and ui fixes
- correct mount path for prompt-config
- **docs**: fix MDX compilation errors in workshop files
- rufflint
- **lint**: fix linting
- **komodor**: improve system prompt and fix a2a noise
- **lint**: fix linting
- **test**: add komodor test prompt
- **lint**: fix linting
- **komodor**: regenerate mcp from openapi spec

### Refactor

- **aws**: make system prompt generic and fix linting issues
- **argocd-mcp**: pin dependencies to latest compatible versions
- **deps**: clean up and align pyproject.toml files
- **build**: remove redundant dev dependencies and pytest config
- **build**: add individual MCP test targets for granular testing
- **build**: decouple test targets for better modularity
- **aws**: remove company-specific references from system prompt
- **aws**: rename agent.py to agent_strands.py
- **aws**: replace company-specific references with generic placeholders
- remove Komodor agent from supervisor configuration
- **aws**: update Strands agent imports and AWS CLI tool integration

### Perf

- **aws**: optimize agent performance with reduced timeouts and semaphores
- **langgraph**: increase recursion limit to 100 for large batch operations

## 0.2.4 (2025-11-24)

### Feat

- **argocd**: add Link column to ArgoCD application tables
- enhance agent prompts and capabilities
- **argocd**: implement two-tier search with automatic exhaustive fallback
- update agents and configuration files

### Fix

- **tests**: ensure test file changes are committed
- **tests**: mock LLMFactory instead of patching env vars for CI reliability
- resolve linting errors

## 0.2.3 (2025-11-21)

### Feat

- bump chart

### Fix

- **workaround**: add ENABLE_ARTIFACT_STREAMING to docker-compose
- updates
- set LLM_PROVIDER env var in test fixtures
- improve complete_result handling and remove ENABLE_ARTIFACT_STREAMING flag
- make agent to dynamically decide available agents
- correct rag-server image repository and bump chart to 0.4.10
- **ci**: prevent docs deployment on tag pushes
- chart was not bumped with prompt config change

### Refactor

- change logger.info to logger.debug for detailed streaming logs

## 0.2.2 (2025-11-20)

### BREAKING CHANGE

- incident_engineer module is no longer available
- Platform engineer agent now uses structured outputs
exclusively. Legacy response formats are no longer supported.

### Feat

- **template**: add PetStore MCP server implementation
- **prompts**: add error handling and security guardrails
- bump chart
- much shorter system prompt for deep supervisor agent
- cahrt bump for prompt config
- ontology agent rewrite for scale
- add webex and argocdv3 ingestors, fix dummy ingestor
- add embeddings factory; separate webloader
- **tools**: add workspace operations and utility tools
- **mcp**: add standardized entry points for MCP servers
- **structured-outputs**: implement structured output support for agents
- **platform-engineer**: implement structured outputs and workspace tools

### Fix

- **docker**: update prompt config path and fix whitespace
- **ci**: correct workflow ID in trigger script
- **ci**: correct workflow ID in trigger script
- **integration**: resolve make quick-sanity test failures
- **logging**: reduce log noise
- **platform-engineer**: filter sub-agent completion signals and preserve DataPart artifacts
- wip 2045
- **prompt**: escape curly braces in TODO example to prevent format() errors
- **executor**: prevent duplicate messages from final response events
- remove tests
- updates
- **agent**: handle tool failures and LangGraph validation errors
- Add 'graph_rag' profile to docker-compose services
- **dev**: updates to jarvis docker-compose
- deal with unseen artifact err
- jira agent tools to hardcode fix for wrong tool calls with params
- **docs**: updates to agent-ops
- **ci**: trigger agent-forge manually
- **docs**: vidcast updates
- reconcile
- reconcile
- **docker-compose**: add MCP host bindings, healthchecks, and configurable prompt path
- deploy script to include GraphRAG services and exclude by default
- embeddings_model typo
- docker-compose: NGINX_ENVSUBST_TEMPLATE_SUFFIX formatting
- **docker-compose**: update profile
- **a2a**: disable structured output by default
- better deep agent prompt and etc
- work with jarvis will required/optional fields
- maintain context id
- webui graph rewrite
- fix backstage ingestor
- add slack ingestor
- fix k8s ingestor
- fix aws ingestor
- Dockerfile fixes
- remove pandas from rag server
- don't build the webui image in main docker-compose
- backstage JWT token is using ES256
- resolve structured outputs compatibility issues
- **a2a**: return brief completion message to prevent content duplication
- **config**: escape template placeholders in YAML prompt config
- **helm**: bump v0.4.5
- **ci**: remove invalid branch prefix from agent-forge SHA tags
- **ci**: ignore argocd and komodor agent tests with missing dependencies
- **docker**: correct agent template name and improve extra_hosts docs
- **docker**: correct agent name for petstore services in docker-compose

### Refactor

- **executor**: make duplicate detection deterministic and update prompt configs
- **petstore**: migrate to BaseLangGraphAgent and shared utilities
- remove agent initialization capabilities greeting and improve prompt config

## 0.2.1 (2025-11-07)

### BREAKING CHANGE

- Agents must now use UserInputMetaData JSON format instead of plain text when requesting user input
- Update A2A protocol field naming from camelCase to snake_case
- Replace artifactId with artifact_id throughout codebase
- Replace messageId with message_id in streaming events
- Replace taskId with task_id in context handling
- Replace contextId with context_id across protocol
- Replace lastChunk with last_chunk in streaming
- Update TypeScript schema in Agent Forge frontend to match

### Feat

- enhance user input transformation with detailed recipe
- add user input metadata format and improve agent orchestration
- add UserInputMetaData format and automatic error retry logic
- enhance agent system with parallel execution and improved UX
- parallelize MCP client initialization with graceful failure handling
- add MCP initialization retry logic with configurable timeouts
- add grep_virtual_file tool for efficient large output search
- add critical directive to preserve sub-agent output details
- add GitHub CI/CD failure analysis directive to system prompt
- enhance multi-agent queries with unified tabulated results
- add our github repo link easy for mobile
- maintain same defaults and properly bump charts
- add redis persistence, external secrets v1 support, and fix dependencies
- add info on PR template
- allow helm pre-release on fork PRs using label
- Use more standard pattern for Helm ingress
- build agent-forge on push to main and remove cronjob
- Support multi-platform Docker builds (AMD64 + ARM64)
- Update agent-forge Dockerfile for AMD64 compatibility
- refactor a2a stream with common code and fix agent-forge workflow
- add prompt templates and agent integration improvements
- Add execution plan markers and creation confirmation policy
- Major streaming architecture improvements and prompt enhancements
- update a2a streaming and agent improvements
- implement A2A streaming and common code refactoring
- refactor a2a_stream with common code
- major ingestor refactor
- add retry when 429 Too many requests
- add istio support and extraDeploy for custom resources

### Fix

- Docker Compose dev file not starting properly
- **docs**: fix npm build errors and broken links
- **agent-aws**: change default AWS agent backend to 'strands'
- disable test-rag-all target in Makefile
- update uv.lock for agent-rag Docker build
- escape curly braces in YAML template for Python format()
- resolve agntcy-app-sdk 0.4.0 compatibility issues
- Remove deprecated A2AProtocol import from agntcy_remote_agent_connect
- Derive a2a_topic directly from agent card name
- Fix agent registry to use agent-card.json endpoint
- Update all agent dependencies to use slim-bindings 0.4.1
- resolve pyproject.toml workspace dependency conflicts
- Change mcp-argocd from workspace to path dependency in argocd agent
- Remove ai_platform_engineering/agents/argocd/mcp from workspace members
- Prevent uv dependency resolution conflicts during Docker builds
- correct indentation errors in Python streaming code
- Fix indentation in agent_executor.py streaming logic
- Fix indentation in base_langgraph_agent_executor.py
- Fix indentation in helpers.py event processing
- Fix indentation in webex agent a2a_server helpers
- use hybrid architecture for A2A tool visibility and streaming
- remove prompts.py subagent generation at import time
- use CustomSubAgents with tools=[] to avoid write_todos conflicts
- stream ToolMessage content to display formatted TODO lists
- enforce A2A agents as tools instead of Deep Agent subagents
- work with CORS for id token auth
- deep_agent prompt with correct {}
- command syntax in user-interfaces.md
- correct ingress path templating and consistent rag ingress
- **docker-compose**: use stable image
- **prompt_config.deep_agent.yaml**: updates
- Logging of authentication configuration
- agent-forge ci gh action
- lint
- Build agent-forge Docker image for AMD64 only
- use shell to cd into workspace directory before starting
- run yarn from workspace root to access state files
- simplify Dockerfile to copy all files at once
- copy .yarn directory to Docker container for Yarn 4.9.4 binary
- remove unnecessary Node.js setup and build steps from workflow
- resolve yarn workspace state file issue in agent-forge build
- updates
- **docker**: align docker-compose contexts with Dockerfile changes
- **docker**: include __main__.py files in agent Docker builds
- resolve RAG unit tests virtual environment and module import issues
- **agents/template**: resolve Docker build failure in CI
- **build**: export PYTHONPATH for all agent run targets
- **build**: add PYTHONPATH and fix RAG server venv detection
- **build**: correct Dockerfile paths in Makefiles to use absolute paths
- **build**: update Makefiles to use repository root as Docker build context
- **docker**: correct RAG Dockerfile paths and enable supervisor builds for prebuild branches
- **docker**: correct A2A directory paths in agent Dockerfiles
- **docker**: correct MCP directory path in agent Dockerfiles
- update weather agent dockerfile
- update rag agent dockerfile
- update webex agent dockerfile
- update confluence agent dockerfile
- resolve Docker build context issues for RAG and A2A agents
- **ci**: resolve RAG agent Docker build context issues
- **ci**: resolve Docker build context issues for agent containers
- **splunk**: apply automatic linting fixes
- resolve test suite issues and enable linting
- restore RAG direct routing and add streaming tests
- Weather and Webex agent environment and MCP configuration
- Update Weather and Webex agent Docker configurations
- **async-streaming**: wip
- **async-streaming**: wip
- Fix linting issues and verify tests pass
- lint and tests
- better docker-compose and temporarily disable aws
- webui with new ingestors
- get agent_ontology with new common libs
- add rag_ontology tests; lots of bugs fixed
- server improvements
- update common module
- graph ui improvements - working buttons
- agent_ontology bug fixes; using tool instead of structured output
- e2e tests for rag components
- add e2e tests; bug fixes; more info in healthz
- agent-rag uses MCP instead of direct DB access
- **auth**: Fix shared key authentication not loading middleware
- rag broken links
- docs - broken links
- docs sidebar - remove unused pages
- rag-arch image
- delete old docs
- update rag docs
- updates
- updates
- updates

### Refactor

- integrate MCP retry logic directly into initialization
- Weather and Webex agents to use BaseLangGraphAgent
- GitHub agent to use BaseLangGraphAgent for consistent streaming
- Move prompt_config.yaml to charts directory and relocate docs
- Refactor AWS agent to use BaseStrandsAgent and BaseStrandsAgentExecutor
- **a2a**: move a2a agent and bindings code to common library

## 0.1.19 (2025-10-22)

### Feat

- **helm**: Add flexible prompt configuration with default and deep agent modes
- up to date helm and external secrets doc
- **helm**: add promptConfig override support
- adding job termination, reload and search weights
- add mcp server for RAG
- add Claude Agent SDK template with A2A and MCP protocol bindings
- add dev version of complete
- allow supervisor agent to work with any remote agent
- add condition to rag-stack and fix webui;
- new rag-stack chart
- add agent_skill_examples in prompt_config
- add ENABLE_<agent> to supervisor cm
- use skills example config
- agent-rag can now filter
- dynamic docker-compose generation with persona-based profiles
- add dynamic docker-compose generator and persona configuration
- add agent-aws-slim and agent-petstore-slim services

### Fix

- better idpbuilder docs;
- **docs**: gh pages
- remove redundant test-data
- add e2e tests; rm local tests
- ui improvements
- RAG ingestion and retrieval bug fixes
- **ci**: Correct dependency verification pattern for helm packages
- **ci**: Skip version check when only Chart.lock changes
- **helm**: skip packaging if chart version already published
- **helm**: ensure rag-stack dependencies always packaged in ai-platform-engineering
- lint and tests
- webui improvements
- uv-lock
- RAG tests; add url santization
- **docs**: use idpbuilder scripts from git repo
- **gha**: updates
- **gha**: updates
- **gha**: updates
- **lint**: updates
- **unit-tests**: updates
- **unit-tests**: multi-agent tests
- **gha**: update supervisor ci name
- **unit tests**: clean-up
- **gha**: build on .github changes
- **gha**: build on .github changes
- **gha**: build on .github changes
- **gha**: update names
- working docker-compose.caipe-complete-with-tracing
- correctly handle aws bedrock streaming format
- rufflint
- make AWS agent to run in executor to prevent blocking
- make supervisor agent work dynamically
- rufflint
- remove empty file
- use fields from pydantic model
- **rag**: add init tests, add delete_all function
- **docker-compose**: use latest
- remove unnecessary files
- optimise search with weighted ranker
- fix
- delete ai.yaml
- no rag name or
- rag-stack needs agentExports
- add rag to supervisor cm
- wrong env place
- fix
- all neo4j hardcoded to port 7687
- handle when chart does not exist in main yet
- update chart version correctly for pre-release
- **README.md**: re-trigger build
- **README.md**: re-trigger the build
- **.dockerignore**: include all rag sources
- **README.md**: retrigger build
- exclude from supervisor, but include clients
- remove `knowledge-bases` .dockerignore
- change to .gitleaksignore
- add nosec to neo4j instantation
- lint
- **rag**: webui nginx; logging; prompt improvements
- agent_rag footnote for filtering
- code comments
- lint errors
- lint
- change dense metric L2 -> COSINE
- agent_rag now checks for graph ontology
- lint

### Refactor

- **multi-agents**: consolidate agent registry with convention-based configuration

## 0.1.18 (2025-10-06)

### Fix

- **rag**: build on all tags

## 0.1.17 (2025-10-06)

## 0.1.16 (2025-10-04)

### BREAKING CHANGE

- none
Closes: #324

### Feat

- **agents**: enhance jira agent and add argocd tests
- **agents**: enhance jira agent and add argocd tests
- add connectors
- add common utils
- unified rag server
- migrate ontology and rag agent
- **deepagents**: add deepagents package locally
- **backstage**: add TechDocs tools for improved documentation access
- disable graphrag in helm chart until fixed
- add tags to helm dependencies
- current experiment-dev-use2-1 values

### Fix

- resolve RAG agent connection issues
- lint
- agent_rag is now like all other agents
- **docker-compose**: remove dev volume mount
- updates
- docker-compose; integrate rag with supervisor attempt
- updates
- **agent-rag**: update uv.lock
- **rag**: update docker compose and bring back clients
- optipnal disable graph-rag; prompt tweaks; raw_query tweaks
- rag-query-test
- agent_rag prompts lint
- Makefile
- gh-workflow, linting, small bugs
- remove deprecated kb_rag
- remove deprecated graph_rag
- fix dockerfiles and docker compose
- remove redundant client and pytest files
- remove more redundant license, changelog etc.
- remove redundant license, changelog etc.
- add package-lock.json for webui
- un-ignore package-lock.json
- add pywright to gitignore
- **format**: deep agents ruff fixes
- **format**: add ruff linting fixes
- **streaming**: remove response format from system prompt
- **streaming**: enable structured output
- **merge**: fix conflicts
- **merge**: fix conflicts
- **backstage**: update lockfile after adding pyyaml dependency
- **idpbuilder**: update docs
- actually bump main chart version
- remove a2a-stable tag reference;
- for now always set is_task_complete as True in order to avoid Queue is closed err
- **kb-rag-agent**: prevent ExternalSecret creation when data is empty
- **idpbuilder**: update paths
- use helm dependency imports
- add note on why slim is a condition
- slim will have to be a condition
- disable all tags by default
- remove all condition
- no condition path by default
- updates
- Remove undefined imports from evals __init__.py
- remove test_extractor.py error file
- pin kb-rag services to sha-f3a1a25
- fix workshop4 to specific version

### Refactor

- improve RAG agent configuration and testing
- **argocd**: modernize string formatting in server.py

## 0.1.15 (2025-09-19)

### Fix

- **ci**: A2A/MCP builds

## 0.1.14 (2025-09-19)

### BREAKING CHANGE

- helm chart version bumped to 0.2.3

### Feat

- **auth**: update A2A authentication configuration
- add additional authentication options for A2A protocol
- add missing agent deployments for aws, splunk, webex, komodor

### Fix

- **ci**: A2A/MCP build and publish on main/tags
- **ci**: A2A/MCP build and publish on main/tags
- **ci**: A2A/MCP build and publish on main/tags
- **A2A_AUTH_SHARED_KEY**: set default to false
- CHANGESET.md
- lint
- updates
- correct commit count for prebuild GHAs

## 0.1.13 (2025-09-18)

### Feat

- upgrade Jira agent to API v3

### Fix

- undo helm values.yaml

## 0.1.12 (2025-09-17)

### BREAKING CHANGE

- test command now runs both general and RAG module tests
- Redis service port name changed from 'http' to 'redis'

### Feat

- idpbuilder values
- add OAuth2 authentication support for A2A protocol
- add integration test workflows and improve agent Docker build automation
- updating collection name from rag-default to rag-united
- backend data management improvements for milvus and redis
- adding addtional config in web UI frontend
- add prebuild docker image github actions
- Only build images if relevant change
- Adding streamable http to Webex agent
- Adding initial, optional Webex agent
- Adding streamable http to Webex agent
- Adding initial, optional Webex agent
- use routing evaluator and tool match evalutor and use the expected ouptut in the dataset
- implement new llm-trajectory match evaluator
- redesign the trajectory and tool call match evaluator
- **trace**: redesign trace processing method to get the tool call
- **evals**: refactor evaluator architecture and switch to OpenAI
- **evals**: add unified trajectory evaluator with graceful LLM fallback
- **evals**: link dataset traces with platform engineer execution
- **evals**: add auto-detection for Langfuse host in upload script
- add expected_output support and separate upload functionality
- add eval service
- major helm chart refactor
- implement memory-optimized batch processing for URL loading
- update agents documentation and sidebar
- enhance coverage reporting with detailed metrics and tables
- **tests**: add comprehensive test suite with memory monitoring and scale tests
- add AWS agent to include cost explorer MCP (#251)
- add kb-rag-web to helm chart
- add the aws agent to platform engineer (#246)
- Addition of Agent Splunk (#247)
- use a2a card to dynamically create client
- added redis db management backend
- added reranking
- frontend now supports RAG config
- add multiple llm provider support for graphrag

### Fix

- updates
- adding generic to custom parser to scrap sites like wikipedia
- updating docker compose for the workshop
- **gha**: update for tags
- gha litellm typo fix
- **mcp-docker-build**: add webex mcp
- update sidebars.ts
- updated loader.py
- updated rag_api
- dividing rag_api for added flexibility and readiness
- adding init file
- changed variable name from UNIFLIED_COLLECTION_NAME TO DEFAULT_COLLECTION_NAME
- renaming: rag_united --> rag_default
- docker compose
- **graph-rag**: lint
- **graph-rag**: heuristics improvements, use graph db to store relation candidates
- correct mcp image builds - use OR not AND
- improve the prebuild github actions
- add litellm to mcp as well
- fixed conflicts between main
- also modify supervisor agent
- AND not OR
- lint
- fix slim to work
- Add queue closed error protection to prevent crashes during shutdown
- unit tests and quick sanity
- ruff linter
- minor formatting in splunk
- added webex to platform engineer
- adding logs to webex mcp
- adding webex to workflows
- updating docker compose
- adding init files to webex client
- **docker-compose.dev**: add p2p-tracing profile to nexigraph
- no default env in kb-rag-server chart
- **evals**: resolve linting issues and remove hardcoded local paths
- **evals**: update evaluation datasets with correct agent names and enable tests
- **evals**: remove unnecessary .python-version and fix Dockerfile
- **evals**: improve A2A client integration and add Azure OpenAI support
- remove relative import
- update docker-compose networking and ports for p2p-tracing
- resolve Docker compose issues for evaluation webhook
- update weather agent dependencies and Docker configuration
- kb-agent-rag requires milvus secret
- smaller milvus res
- remove excessive resource requests
- remove node selector and limit eph storage
- further cleanup
- remove unsued env
- bring latest milvus vals and template milvus uri
- try more delay
- revert wrong change
- default llmSecrets in kb-rag-server
- correct liveness and readiness port for kb-rag-agent
- kb-rag-server also requires llm secret
- copy working milvus values
- move milvus to the parent chart
- milvus is INSIDE kb-rag-stack...
- remove deprecated isMultiAgent
- correct appVersion
- properly fix kb-rag-agent secrets
- modify kb-rag-stack for the same change
- resolve unit test failures and improve memory optimization
- mcp_splunk symlink to be in-repo relative
- **rag**: restructure package to use rag.server.* namespace
- **docker**: update Dockerfile for new package structure
- **rag**: update coverage configuration for new package structure
- **helm**: bump chart version to 0.1.18
- **rag**: restructure KB-RAG package with proper scoping
- **ci**: resolve KB-RAG Stack Helm chart test failures
- **ci**: resolve Helm chart test failures in GitHub Actions
- **docs**: resolve broken links causing Docusaurus build failures
- **ci**: add proper download links for coverage artifacts
- correct XML attribute access for coverage parsing
- handle missing main coverage and improve coverage reporting
- update remaining uv.lock files and add coverage debugging
- update uv.lock files to resolve Docker build issues
- add debugging and error handling for coverage XML parsing
- update uv.lock files to resolve Docker build issues
- remove stray 'p' character causing JavaScript ReferenceError
- add --index-strategy unsafe-best-match for PyTorch CPU installation
- use --extra-index-url instead of --index-url for PyTorch CPU installation
- update a2a-sdk dependency format and workspace configuration
- resolve a2a-sdk dependency issue in CI
- install CPU-only PyTorch in RAG tests to avoid NVIDIA packages
- Pin all a2a-sdk versions to 0.2.16
- Add missing fs import in GitHub Actions workflow
- Resolve Docker build workspace member issues
- Exclude RAG module tests from main test suite
- Remove Poetry dependencies and migrate RAG module to UV
- unit tests and linting
- lint
- **rag**: replace incorrect ascrape method with proper LangChain async methods
- optimize memory usage by streaming page processing (#253)
- **kb-rag-redis**: correct service port configuration to match deployment (#252)
- add milvus to parent chart
- updates
- updates
- update kb-rag-server
- update kb-rag-server
- **kb-rag-agent**: restore
- **kb-rag-stack**: add condition: agent.enabled
- remove kb-rag-agent dedicated chart
- updates
- just add a new subchart for now
- default no SA
- **aws**: ruff lint
- broken links
- updates
- remove debug line
- **aws-agent**: ruff lint
- fixed readme and created agent container
- add try/except when agent is unreachable
- docker compose dev
- docker compose dev
- docker compose dev
- docker compose dev
- add misc utils - run coroutine in sync
- cleanup how we do agent enabled
- ruff lint
- **graph-rag**: qa agent now fetches properties before raw query
- created was being updated regardless
- ruff linter
- clean kb-rag workflow to reduce space usage
- ruff linter
- ruff linter
- added dockerignore
- updated docker compose
- update uv lock
- include in pyproject
- get rid of non existing func
- much simpler fix :)()(
- ruff linter
- **workshop**: mission4: rag-agent docker port -> 8020
- **workshop**: mission4: rag-agent docker port -> 8020
- **workshop**: mission4: switch to main tag for github agent
- **workshop**: mission7
- **workshop**: mission7
- **github**: add load_dotenv
- updates sidebars.ts for docs
- png to svg
- png to svg
- **workshop**: mission4: add restart policy to docker compose
- updating port number for kb-rag
- typo for logger message
- **workshop**: switch mission4 to a different env file
- **weather**: add self.mcp_api_key

### Refactor

- **evals**: improve eval run naming with readable timestamp format
- **evals**: clean up directory structure and remove obsolete files
- remove hardcoded agent detection and use dynamic regex patterns
- create kb-rag-stack

## 0.1.10 (2025-08-26)

### Fix

- **petstore**: add PETSTORE_API_KEY support
- correct petstore mcp env var name
- Update README.md (#230)

## 0.1.9 (2025-08-26)

### Fix

- **github**: add ENABLE_MCP_TOOL_MATCH feature flag (#229)
- ruff lint
- rag ingestion crash; workshop docker file

## 0.1.8 (2025-08-25)

### Feat

- **argocd**: add argocd sanity tests for local argocd kind instance (#224)

### Fix

- **petstore/weather**: bug fixes (#225)
- **docs**: escape  in Jira MCP comparison table for MDX compatibility
- update navigation

## 0.1.7 (2025-08-25)

### Feat

- **workshop**: add workshop 7 docker-compose
- add http mcp remote support for petstore and weather agents
- implement job tracking and ingestion progress for URL processing
- initialize frontend for KB RAG with React, Vite, and Tailwind CSS
- create dev mission docker file
- add petstore to docker-compose.weather
- add multi-agent dynamic connectivity and petstore refactor
- add weather agent with stdio mcp server
- adding rag-ingestion pipeline
- **brand**: update docs to CAIPE branding (#211)
- add eval prompts (#191)
- **docker**: use multi-stage builds to reduce container size (#198)
- add a new graphrag helm chart

### Fix

- docker-compose.mission2.yaml
- **weather**: use remove URL (#223)
- **workshop**: remove langfuse components from mission 7
- **workshop**: add network host to langfuse web
- **workshop**: remove rag from mission 7
- **workshop**: remove profiles from docker compose 7
- **docs**: update solution architecture
- **docs**: update solution architecture
- **docs**: update solution architecture
- add docker build for kb-rag ui
- add mission docker-compose, add prgress message for chunked doc
- **README.md**: add start history (#217)
- lint errors and argocd mcp bugs (#218)
- ruff lint
- **argocd**: test and validate mcp after auto-generation changes (#215)
- update reference/source when outputting answer
- default top_k for query 10 -> 3, better log
- add empty document fields instead of omitting
- kb-rag-agent image
- add weather for a2a build gh action
- lint
- petstore agent and refactors
- Dockerfile, add page counter
- **argocd**: add VERIFY_SSL and ARGOCD_VERIFY_SSL support in mcp (#209)
- removing knowledge base from .dockerignore
- **argocd.md**: update kubectl context
- **kb**: add init file to make it a package
- **kb**: add init file to make it a package
- **common.mk**: make run-mcp
- adding init files
- platform engineering workflow push to main
- **docker-compose**: remove a2a- prefix (#200)
- docker latest images with uv.lock (#199)
- replace dotenv to python-dotenv
- **uv**: add dotenv
- **uv**: add dotenv
- remove bad file change
- bump all chart v and app v
- mount path
- fix multiagent volume mount and clean up
- no lb
- fix2
- fix"
- neo4j official chart
- redis
- no probe
- similar env fix
- correct var names
- set storage class default to gp2 for now
- wrong secretRef path
- create json file and make graphrag optional
- add SA field

## 0.1.5 (2025-08-15)

### Feat

- fix Langfuse trace ID propagation in multi-agent system (#195)
- **helm**: add useRemoteMcpServer to use remote MCP server (#193)
- add mcp http support to helm chart (#190)

### Fix

- Dockerfile improvements and add .dockerignore (#197)
- fix missing sub helm chart bump
- mcp dockerfile to give .venv permissions (#192)

## 0.1.4 (2025-08-12)

### Fix

- **build**: update workflow triggers
- **build**: remove a2a prefix for agent container images
- **build**: build and publish agents on every push to main and tags

## 0.1.3 (2025-08-12)

### Feat

- add slim to helm chart (#187)
- use agntcy-app-sdk to integrate with agntcy slim (#171)
- **graph-rag**: add evaluation and tests
- embed vidcast in idpbuilder doc
- add a new pre-release helm chart github action
- output URL to help user.
- updated kb-rag from agent-rag
- implement distributed tracing across all agents (#139)
- add idpbuilder docs (#142)
- allow external url as the A2A url (#122)
- intial commit incident engineer (#111)
- **graph_rag**: create nexigraph graph rag system (#97)
- **rag**: doc load, embed, vector store, retrieve (#96)
- updates
- updates
- remove dependency.yml
- updates
- update OSS artifacts and github actions
- add some colours to the docs code block
- add doc for eks deployment
- **helm**: add command and args to deployment
- **helm**: publish chart
- add CORS and use LLMFactory
- use cnoe_agent_utlis
- publish helm
- added ci pipeline
- added ci pipeline
- added A2A server and re-formatted
- add A2A integration and new MCP server (#5)
- Use cnoe utlis to get rid of llm_factory to encompass latest LLMs
- added google's A2A server and client side
- short term memory to the agent
- add helm publish
- add CORS and fix lint errors
- use cnoe_agent_utlis instead of llm_factory
- add agent forge
- **agent-komodor**: add komodor agent
- add script to automate Helm configuration for new agents
- **docs**: add docs website
- implement dual-mode docker-compose and update the readme and example env
- **tracing**: use env to enable tracing
- monkey patch a2a noise
- implement langfuse v3
- publish helm
- added ci pipeline
- added ci pipeline
- added A2A server and re-formatted
- add A2A integration and new MCP server (#5)
- adding confluence agent
- publish helm
- added ci pipeline
- added ci pipeline
- added A2A server and re-formatted
- add A2A integration and new MCP server (#5)
- add agent-a2a-docker-build.yml
- add mcp server support (#45)
- **helm**: Implement helm chart (#42)
- propogate context_id from user client LangGraph thread_id (#34)
- **Dockerfile**: add multi-arch support
- **cors**: add CORS and update ACP/A2A graph entry point (#11)
- add A2A integration and new MCP server (#5)
- adding 6th agent backstage
- allow custom prompts via YAML config and restore original agent/platform prompt defaults

### Fix

- **build**: add latest tag for agent builds
- add kb-rag to Platform Registry
- readding new clients to kb-rag
- updated-docker compose
- format in agent a2a docker builder
- **a2a-docker**: publish on main and tags
- mcp docker improvements (#186)
- quick sanity tests and docker-compose files (#185)
- **quick-sanity**: add komodor variables
- **quick-sanity**: clean-up workspace
- **quick-sanity**: update variables
- **quick-sanity**: update runner name
- **quick-sanity**: use caipe-integration-test-runner
- **mcp**: use mcp-xxx container names
- **ipdbuilder**: update idpbuild docs (#182)
- linting, add eval results for graph-rag
- **graph-rag**: give similar relations when evluating
- **README.md**: add note to latest docs
- docs images need to be svg not png
- update chunk number
- using the right azure embeddings
- updating prompts
- ruff linter
- loaded kb-rag into caipe's environment
- another version number
- updated a2a version
- surpress milvus logs
- github workflows
- renamed kb-rag to rag to fix import errors
- updated kb_rag
- fixed breaking change
- updated docker-build
- added kb-rag
- updated docker builder
- updated docker build
- **docs**: update tracing docs
- add profiles to graph_rag/nexigraph services
- remove a2a from nexigraph images
- add ghcr.io prefix to images
- nexigraph client path
- nexigraph build path
- docker-compose graphrag image
- **docs**: nexigraph agent names
- helm correct externalSecret templating
- agent-jira and agent-confluence (#133)
- ruff lint
- **graph-rag**: adding tests for heuristics; better heuristics; more accurate evalaution
- helm chart agent-forge needs http for healthcheck
- always pull and expose external url
- **lint**: errors
- **supervisor_agent**: system prompt optimization and use agent tools (#117)
- **atlassian**: remove agent-atlassian (#116)
- add tools, utils and meeting recordings
- **docs**: ics file path
- **docs**: ics file path
- **docs**: ics file path
- **README.md**: update arch diagram
- ruff linter fails (#102)
- allow multiple ports for agents
- **tracing**: enable tracing in local build docker-compose
- remove GOOGLE_API_KEY dependency
- **docker-compose**: restore
- import error
- **prompts**: update backstage import
- **docker-compose**: create multiple profiles build, latest (#98)
- **a2a-docker**: update triggers
- **clean-up**: remove helm charts
- remove .DS_Store
- reconcile updates
- migrate agent-pagerduty
- ruff linter
- updated line length ruff linter
- deleted tests
- updated mcp server to reflect correct imports
- updated imports
- docker action build
- cleanup of agent-template
- updated dependencies
- updates
- **Makefile**: clean-up targets
- updates to code
- reconcile PR comments
- add ai_platform_engineering/agents/argocd/build/Dockerfile.mcp
- **lint**: reconcile
- **ci**: run A2A parallel build on PR push
- **langgraph**: updates
- **clean-up**: remove redundant files
- **ci**: build all agent docker images
- updates
- updates
- add Dockerfile.a2a
- **agents**: update Dockerfile.a2a file and clean-up
- update build/Dockerfile.a2a
- **docs**: authors.yml
- **docs**: broken link
- correct sidebar order
- helm deployment rendering fix
- update app and chart versions to 0.1.3 and adjust secret reference logic in deployment.yaml
- correct conditional logic for secret reference in deployment.yaml
- update app and chart versions to 0.1.2 and adjust values for backstage plugin
- lint errors in add-new-agent-helm-chart.py
- agent-forge should be port 3000
- bump helm chart patch version
- updated stable tag
- mcp server api/catalog fixes
- remove .keep files
- **Dockerfile**: use python:3.13-slim
- client side context_id
- server side context_id
- ruff lint changes
- async error fixed.
- lint errors
- lint github actions
- **Dockerfile**: use python:3.13-slim
- updates
- updates
- client side context_id
- server side context_id
- remove AzureChatOpenAI in agent
- remove AzureChatOpenAI in agent
- **jira**: update search results
- lint errors
- add CORS support
- add ruff in ci pipeline
- ci errors
- remove acp docker build
- remove GOOGLE_API_KEY
- README.md
- **acp**: update run-acp based on latest wfsm changes
- **acp**: update run-acp based on latest wfsm changes
- update GHA
- **acp**: update run-acp based on latest wfsm changes
- **SECURITY.md**: add CNOE steering committe email
- update docker-build-push.yaml
- update copyright headers
- add argocd_mcp submodule
- **Dockerfile**: use python:3.13-slim
- **helm**: publish helm chart
- server side context_id
- client_slide_context_id
- add CORS support
- ruff pipeline
- ci errors
- ci updates
- remove GOOGLE_API_KEY
- **acp**: update agent.json
- **acp**: update agent.json
- updated .gtihub
- added dockerfile.a2a and acp
- path changed for docker acp and a2a
- update a2a and acp docker
- updated docker files in .github
- remove invalid async context usage with MultiServerMCPClient
- technical issue with data retrieval
- pagerduty token and logs
- **docs**: updates
- **README.md**: updates
- **README.md**: updates
- **README.md**: updates
- **README.md**: updates
- **README.md**: updates
- **docs**: update README.md
- **Dockefile**: use python:3.13-slim
- **helm**: change default service port to 8000
- **helm**: rename chart to agent-github
- ruff linter
- use LLMFactory and lint errors
- remove acp docker build
- ruff lint
- client side context_id
- server side context_id
- **docs**: add some under construction anchors
- **docs**: add github issues
- **docs**: broken link
- **docs**: update usecases
- **.env.example**: remove it to fix linter
- helm gh wf with correct paths
- helm chart push on merge
- **docs**: updates
- Update user-interfaces.md
- broken links
- **komodor-agent**: only deploy komodor agent if use docker compose override
- **komodor-agent**: use llm factory instead of langchain library
- update python script name
- reconcile
- **docs**: README.md
- **docs**: updates
- **docs**: updates
- **docs**: updates
- **docs**: update sidebars.ts
- **docs**: add blog and simplify
- updates
- editUrl link
- **docs**: update edit links
- **docs**: github action publishing update baseUrl
- **docs**: github action publishing
- **docs**: github action publishing
- **docs**: github action publishing
- add langfuse reference
- updates
- merge updates
- add missing import os
- updates
- updates
- client side context_id
- server side context_id
- remove AzureChatOpenAI in agent
- remove AzureChatOpenAI in agent
- **jira**: update search results
- lint errors
- add CORS support
- add ruff in ci pipeline
- ci errors
- remove acp docker build
- remove GOOGLE_API_KEY
- README.md
- **acp**: update run-acp based on latest wfsm changes
- **acp**: update run-acp based on latest wfsm changes
- update GHA
- **acp**: update run-acp based on latest wfsm changes
- **SECURITY.md**: add CNOE steering committe email
- update docker-build-push.yaml
- update copyright headers
- add argocd_mcp submodule
- docker container build
- fixed agent tools
- updates
- updates
- client side context_id
- server side context_id
- remove AzureChatOpenAI in agent
- remove AzureChatOpenAI in agent
- **jira**: update search results
- lint errors
- add CORS support
- add ruff in ci pipeline
- ci errors
- remove acp docker build
- remove GOOGLE_API_KEY
- README.md
- **acp**: update run-acp based on latest wfsm changes
- **acp**: update run-acp based on latest wfsm changes
- update GHA
- **acp**: update run-acp based on latest wfsm changes
- **SECURITY.md**: add CNOE steering committe email
- update docker-build-push.yaml
- update copyright headers
- add argocd_mcp submodule
- helm chart workflow improvements
- correctly add global secretName
- **argocd**: update poetry.lock
- **multi_agents**: rename mas->multi_agents
- github actions workflows
- **gha**: typo
- **poetry**: updates
- build docker errors
- update test dependencies
- unit tests
- lint
- import errors
- **query-params**: Don't add query param to request if None (#44)
- **Dockerfile**: use python:3.13-slim
- **api**: support nested body parameters and fix boolean types
- **helm**: default service port 8000
- **helm**: version 0.1.1
- **helm**: Update image.tag in values.yaml
- **helm**: updates
- **helm**: updates
- **helm**: updates
- **helm**: only trigger on tags
- **test**: lint errors
- **helm**: update gh workflow
- **helm**: update gh workflow
- **README.md**: update local dev tasks
- temporarily remove api_v1_applications_manifestsWithFiles
- update mcp_server bindings (#33)
- **README.md**: updates
- **README.md**: update architecture diagram
- add MCP_VERIFY_SSL for local development and update README (#32)
- rename to A2A_HOST and A2A_PORT (#31)
- **acp**: docker image
- updates to A2A client (#22)
- update to use argocd
- updates with AGENT_NAME
- **MAINTAINERS.md**: updates
- **README.md**: status badgese
- update README.md
- **README.md**: demos
- **README.md**: project structure
- **README.md**: update badges
- **agent.json**: update to conform to new specification (#12)
- **README.md**: update mcp server link
- import error for a2a and python3 (#9)
- **protocols**: add a2a-sdk and update makefile (#10)
- README.md
- **acp**: update run-acp based on latest wfsm changes
- **acp**: update run-acp based on latest wfsm changes
- update GHA
- **acp**: update run-acp based on latest wfsm changes
- **SECURITY.md**: add CNOE steering committe email
- update docker-build-push.yaml
- update copyright headers
- add argocd_mcp submodule
- updates
- updates
- prompt_config.yaml
- add prompt_config_example.yaml
- minor fixes
- updates
- **Makefile**: update run-ai-platform-engineer and set run as default target
- **docker-compose**: comment out agentconnect by default
- add incident_engineer placeholder
- **env**: use .env instead of .env.foo per agent
- **docker-compose**: restore agentconnect ui
- add CORS and update system prompt
- **a2a**: update docker-compose bring up
- **Makefile**: add setup-venv
- update the default AGENT_PORT 8000
- updates
- unittest, lint and container name
- updates
- **Dockerfile**: update ci
- updates

### Refactor

- prompt config to use structure output. Use UV, langgraph==0.5.3, a2a-sdk==0.2.16 (#155)
- **docs**: simplify the top level menu (#110)
- **agent-atlassian**: remove and update that it is split into Jira and Confluence agents (#103)
- **multi_agents**: move build directory
- update Makefile, Dockerfiles, and clients for LangGraph agent deployment
- with latest changes
- create protocol_bindings directory for acp/a2a/mcp
- updated a2a, acp, mcp and docker addition
- updated previous acp and standardized new format.
- with latest changes
- create protocol_bindings directory for acp/a2a/mcp
- with latest changes
- create protocol_bindings directory for acp/a2a/mcp
- **external-secrets**: improve secret name handling and update configuration examples
- **monorepo**: rename mas->multi_agents, use seperate mcp python project
- **agent-argocd**: collapse to ai-platform-engineering
- clean-up old code and update docs (#38)
- docker support, clean-up, new chat client interface (#13)
- create protocol_bindings directory for acp/a2a/mcp
- optimize system prompt from a2a cards and skills
