# Bot Harness Gateway transport

Slack and Webex independently opt into detached Harness Engine execution through
the existing UI/BFF. Both switches default to `false`; Admin UI controls are not
part of this setting.

| Bot | Environment variable | Helm value |
|---|---|---|
| Slack | `SLACK_HARNESS_GATEWAY_ENABLED` | `slack-bot.config.SLACK_HARNESS_GATEWAY_ENABLED` |
| Webex | `WEBEX_HARNESS_GATEWAY_ENABLED` | `webex-bot.config.WEBEX_HARNESS_GATEWAY_ENABLED` |

```yaml
slack-bot:
  config:
    SLACK_HARNESS_GATEWAY_ENABLED: "true"
webex-bot:
  config:
    WEBEX_HARNESS_GATEWAY_ENABLED: "false"
```

- For Compose, set either variable in `.env` and recreate that bot service.
- Configure Harness Engine on the BFF and enable the agent's runtime first.
  Deep Agents additionally requires `HARNESS_ENGINE_DEEP_AGENTS_ENABLED=true`
  on the BFF. Existing native conversations retain their runtime binding.
- `CAIPE_API_URL` remains the BFF URL. Bots do not connect directly to workers,
  Engine storage, or MCP services.

## Request and replay

```mermaid
sequenceDiagram
  participant Bot as Slack / Webex bot
  participant BFF as BFF Harness Gateway
  participant Engine as Harness Engine
  Bot->>BFF: POST /api/harness-engine/runs (caller token, idempotency key)
  BFF->>BFF: Authorize agent use and conversation write
  BFF->>Engine: Admit server-owned run
  BFF-->>Bot: run_id
  Bot->>BFF: GET /runs/{run_id}/events/stream?protocol=agui&after=0
  Engine-->>BFF: Persisted events
  BFF-->>Bot: AG-UI events with sequence.part cursors
  Note over Bot,BFF: Subscriber connection drops; execution continues
  Bot->>BFF: GET events after last delivered cursor (reauthorize)
  BFF-->>Bot: Remaining events, including terminal result
```

- Admission transport failures and HTTP 502/503/504 retry at most five times,
  retaining one idempotency key. Once admitted, only the subscription reconnects.
- Slack message timestamps (scoped by workspace/channel) and Webex message IDs
  produce stable admission keys for redelivery of the same platform message.
  Calls without a delivery ID receive a fresh key for that invocation.
- If admission conflicts after redelivery rebuilds the thread context, the bot
  looks up the original run through the BFF and replays it. Lookup requires
  current agent-use and conversation-write access and is scoped to the caller,
  agent, conversation epoch and delivery key. It cannot start a replacement run
  or change the original input fingerprint. A missing run remains a conflict.
- Reconnects use numeric event/subframe cursors; duplicate events are discarded.
  Incomplete SSE frames replay from the previous complete frame.
- Empty/failed subscriptions retry at most five times, resetting the budget
  when a new event arrives. Exhaustion reports that the server run may remain
  active. Closing a subscription never sends a provider cancellation.
- Only explicit `HARNESS_RUNTIME_MISMATCH` or `APP_STREAM_REQUIRED` responses
  before admission use the existing native/app stream. Other failures stop.
- Turning a switch off restores the previous bot transport on subsequent calls;
  it does not cancel already-admitted runs. HITL uses the existing resume route.

## Identity and persistence boundaries

- Admission and replay use the same existing OBO/service-account token selection.
  Each attach rechecks access; token expiration or permission denial stops replay.
- No sharing grants, tool permissions, or user credentials change. Webex's native
  app fallback retains its signed room/thread context.
- This transport stores neither bearer tokens nor delivery cursors on disk.
- Engine run persistence survives subscriber loss. **Automatic bot delivery
  catch-up after a bot process restart is not implemented.** There is no durable
  notification outbox or saved renderer state. Platform redelivery reuses the
  admission key but may replay previously delivered text into a new bot reply.
- Reconnects cannot resume provider work lost to worker failure; provider/Engine
  recovery guarantees remain runtime-specific.
