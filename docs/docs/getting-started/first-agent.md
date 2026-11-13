---
sidebar_position: 2
---

# Your first agent

Open **Admin → Platform configuration → Setup Wizard**. You need one reachable
model and the agent runtime for your first conversation. Tools, knowledge bases,
connected accounts, and automation can be added later.

## When setup appears

- Eligible admins see a setup checklist on a fresh installation (no conversations
  or custom agents, and at most one user), or while saved setup is in progress.
- The full wizard opens when the admin chooses to start or resume it.
- Completed, dismissed, or hidden setup does not prompt automatically.
- **Tour → Setup experience** in the top-right bar opens the setup page for
  admins. Choose **Start setup**, **Resume setup**, or **Run setup again** there.
- `SETUP_WIZARD_ENABLED=false` suppresses automatic onboarding. Manual setup
  and workspace tour replay remain available.

## Complete basic setup

1. **Welcome:** review the brief readiness summary. **Open Platform Health** for
   service inventory, component logos, detailed checks, and remediation links.
   A disabled optional service does not prevent a basic conversation.
2. **Choose a model:** the model is the AI that writes your agent’s replies. The
   displayed choice is for this starter agent, not a platform-wide default.
   Keep it or open **Change model** to search the catalog. Registration alone
   does not verify provider access; the final conversation tests that connection.
   For a different provider, open **Configure provider access** and configure
   its endpoint and authentication in the provider workspace,
   then register/select the model. A model name alone does not configure access.
   See [Provider credentials](#provider-credentials) for saved-secret selection.
   LiteLLM uses an OpenAI-compatible endpoint. For Bedrock on Kubernetes, prefer
   workload identity such as an IAM role for a service account or EKS Pod Identity.
3. **Choose an agent:** pick SRE starter, Hello World, or a blank agent. Recipes
   provide instructions; operational tools must be connected separately.
4. **Add context (optional):** choose Accounts, Tools, Knowledge, or Team channels.
   Use **Try without extras** to start with a model-only conversation.
5. **Try your agent:** review the selection and run the test. Success means the
   agent returned a response. If it fails, check provider access and platform
   health, then retry. **Test later** saves your place without claiming success.

## Provider credentials

**Model Providers** shows all supported providers, even before a model is registered.

- Choose **Choose a saved secret** for a searchable list of permitted secrets.
  Saving keeps the reference; it does not copy or reveal the value.
- Choose **Enter a new value** to create an encrypted entry in
  **Credentials → Saved Secrets**. Empty lists default to this option.
- Use **Share** on a saved secret to grant team access, **Rotate** to replace its
  value, or **Delete** and confirm to remove it. Deleting a saved key does not
  revoke it at the provider.

| Provider | Configuration choices |
| --- | --- |
| OpenAI / Compatible | Any OpenAI-compatible API base URL and API key |
| Anthropic Claude, Google Gemini, Groq | API key |
| Azure OpenAI | Endpoint, API version, and API key |
| AWS Bedrock | Deployment IAM, or access key ID, secret access key, region, and optional session token |
| Vertex AI | Deployment Application Default Credentials |

**Current limitation:** saved provider choices are not yet applied to model
execution. The runtime uses deployment credentials. End-to-end connection
configuration and testing remain tracked in
[#2231](https://github.com/caipe-io/ai-platform-engineering/issues/2231).
Use a provider already configured in the deployment for the conversation test.

## Leave and return

- Use **Expand setup width** in the header for more room; **Restore setup width**
  returns to the compact layout without losing your step or selections.
- **Save & minimize**, the minimize icon, and links to CAIPE workspaces save
  your current step and selections before shrinking setup into the resume bubble.
- Complete the task in the destination workspace, then choose **Resume setup**.
- Navigation does not reopen the wizard automatically.
- **Don’t show again** hides the checklist. The permanent Setup Wizard page in
  Admin remains available, including after basic setup is complete.
- Restarting setup resets the setup checklist; it does not remove agents,
  credentials, models, or knowledge bases created earlier.

## Enable optional features

A navigation checkbox controls visibility. It cannot install a missing service.
Ask the deployment administrator to configure the feature and restart/redeploy
the UI; deploy its backend where required. Then refresh setup.

| Feature | Deployment requirements | Guide |
| --- | --- | --- |
| Workflows | `WORKFLOWS_ENABLED=true`, `WORKFLOW_RUNNER_ENABLED=true`, and a working agent runtime | [Workflows](../features/workflows.md#enable-workflows) |
| Schedules | Scheduler backend, authentication/runner wiring, `SCHEDULER_ENABLED=true`, and reachable `SCHEDULER_URL` | [Scheduler](../architecture/scheduler.md#enable-the-scheduler) |
| Autonomous agents | Autonomous service, its authentication configuration, `ENABLE_AUTONOMOUS_AGENTS=true`, and reachable `AUTONOMOUS_AGENTS_URL` | [Autonomous agents](../architecture/autonomous-agents.md#helm-configuration) |
| Apps | `AGENTIC_APPS_INSTALL_ENABLED=true`, a catalog at `AGENTIC_APPS_CONFIG_PATH`, and the app signing configuration | [External Apps](../features/agentic-apps.md#configure-the-host) |
| Knowledge | RAG service and dependencies, ingestion, and an accessible knowledge-base MCP server | [Knowledge bases](../knowledge_bases/index.md) |
| Team channels | A configured bot integration and its service | [Slack](../integrations/slack-bot.md), [Webex](../integrations/webex-bot.md) |

Connected accounts require an enabled OAuth connector. Open **Configure connected
apps** to set up the provider, then **Credentials → Connected Apps** to connect
your account. Provider support determines whether dynamic client registration is
available; an arbitrary MCP URL does not guarantee OAuth or DCR support.

## Skip guided onboarding

Setup is optional. Choose **Exit setup** at any step to save your choices and
hide the checklist across sessions without marking setup complete. Resume from
**Admin → Platform configuration → Setup Wizard** whenever needed.

To suppress the automatic setup checklist and product tour for the deployment,
set these Helm values and upgrade the release:

```yaml
caipe-ui:
  config:
    SETUP_WIZARD_ENABLED: "false"
```

For the standalone UI chart, use `config.SETUP_WIZARD_ENABLED: "false"`.
For Docker Compose, set `SETUP_WIZARD_ENABLED=false` and recreate the UI container.
For the installer, use `--no-setup-wizard` or `ENABLE_SETUP_WIZARD=false`.
Manual setup in Admin and tour replay in Settings remain available.

## Explore the workspace

Choose **Tour → Workspace tour** in the top-right application header, or
**Take a tour** on the Setup Wizard page.
The guide highlights the navigation while you keep using the workspace. Use
**Next** and **Back** to explore Home, Chat, Skills, and personal settings; links
open the related workspace using the usual unsaved-change protection.

Minimize the guide to a **Resume tour** button, or close it whenever you like.
Progress is saved to your account. Replay it from the header or Settings.
Deployment details and optional navigation capabilities stay collapsed until
you request them; setup keeps the next decision in focus.

## Task tours

The top-right **Tour** menu includes short guides for:

- **Add a model:** connect its provider, register identifiers, and verify with chat.
- **Add an MCP server:** configure the endpoint and authentication, then test a tool.
- **Add an agent:** choose a model and audience, write instructions, attach tools, and try it.
- **Chat with an agent:** select an agent, ask a question, inspect evidence, and follow up.
- **Connect credentials:** authorize a connected app, check its health, or save a secret.

Each task tour saves its own progress to your account and starts only when requested.
Choosing an unfinished task resumes it; choosing a completed or skipped task starts
it again. Use **Next** after performing each action. **Finish tour** records guide
completion; it does not verify or create the resource. Model, MCP, and agent guides
appear when the agent workspace is enabled and your account has access. Connected
credentials guidance appears when account connections and persistent storage are enabled.
The underlying screens enforce the permissions required for each action.
