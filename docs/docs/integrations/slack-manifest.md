# Slack App Manifest — Personal DM commands

The bot needs four personal slash commands registered on
the Slack app:

| Command         | Where it works              | What it does                                                                                              |
|-----------------|-----------------------------|-----------------------------------------------------------------------------------------------------------|
| `/caipe-help`   | DM, channels, group DMs     | Shows the list of bot commands and the DM dispatch order (FR-030).                                        |
| `/caipe-list`   | DM, channels, group DMs     | Lists the agents the invoking user is authorized to use (FR-028, FR-036).                                 |
| `/caipe-use`    | DM only (`<agent>` form)    | Sets a per-thread DM agent override, or `/caipe-use default` to clear saved preference (FR-029, FR-029a). |
| `/caipe-effort` | DM only                     | Sets the reasoning effort for the invoking user's next DM and that conversation.                         |

All four commands return ephemeral replies (FR-034) and are rate-limited
per user (FR-035, default 5 commands per 30s — see
`SLACK_COMMAND_RATE_LIMIT` / `SLACK_COMMAND_RATE_WINDOW`).

## Required `app_manifest.yaml` additions

Add a `slash_commands` block under `features` containing the four
commands. Slack requires a unique URL per command — for Socket Mode
deployments the URL is unused but still required by the manifest schema,
so we use the canonical request endpoint.

```yaml
features:
  bot_user:
    display_name: CAIPE
    always_online: true
  slash_commands:
    - command: /caipe-help
      description: Show CAIPE bot commands and dispatch order
      usage_hint: ""
      should_escape: false
    - command: /caipe-list
      description: List the agents you can use
      usage_hint: ""
      should_escape: false
    - command: /caipe-use
      description: Route this DM thread to a specific agent
      usage_hint: "<agent-id> | default"
      should_escape: false
    - command: /caipe-effort
      description: Set reasoning effort for this DM conversation
      usage_hint: "<low|medium|high|max>"
      should_escape: false
```

> When using Socket Mode (`socket_mode_enabled: true`) the manifest does
> not need `request_url` entries for slash commands. For HTTP mode the
> commands all share the same Bolt receiver URL.

## Required OAuth scopes

The commands rely on the bot's existing OAuth scopes. Specifically the
following must already be in your manifest:

| Scope                | Why                                                                       |
|----------------------|---------------------------------------------------------------------------|
| `commands`           | Required to register slash commands at all.                               |
| `chat:write`         | Posting the ephemeral reply to the invoking channel.                      |
| `users:read`         | Resolving the invoking user to their Keycloak identity (OBO).             |
| `users:read.email`   | Email-principal lookup for OpenFGA grant matching (existing dependency).  |
| `im:write` (optional)| Useful when the bot needs to DM a user; not strictly required for the commands themselves. |

No new OAuth scopes are required for the effort command.

## Where the wiring lives

| Code                                                                                                | Purpose                                          |
|-----------------------------------------------------------------------------------------------------|--------------------------------------------------|
| [`slack_bot/personal_routing.py`](https://github.com/caipe-io/ai-platform-engineering/blob/main/ai_platform_engineering/integrations/slack_bot/personal_routing.py) | Bolt registration and DM routing. |
| [`slack_bot/utils/slash_commands.py`](https://github.com/caipe-io/ai-platform-engineering/blob/main/ai_platform_engineering/integrations/slack_bot/utils/slash_commands.py) | All command logic + user-facing copy.                  |
| [`slack_bot/utils/dm_agent_resolver.py`](https://github.com/caipe-io/ai-platform-engineering/blob/main/ai_platform_engineering/integrations/slack_bot/utils/dm_agent_resolver.py) | DM dispatch chain used by `handle_dm_message`.         |

## Release notes pointer

Add the manifest update to the deployment runbook before deploying the bot
image. See [the RBAC release notes](../security/rbac/index.md) for the
consolidated rollout guide.
