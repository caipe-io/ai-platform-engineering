# RBAC End-to-End Smoke Scripts

Architecture: [`docs/docs/security/rbac/workflows.md`](../../../docs/docs/security/rbac/workflows.md)

These scripts validate the **Phase 2 personal-DM experience** against a
running dev stack. They are intentionally NOT wired into `make test` /
CI — they require a Slack workspace, Webex bot, and a real OpenFGA/MongoDB
store, and they make changes (user preferences, OpenFGA tuples) that we
don't want CI poking at.

## Prerequisites

1. `make test-rbac-up` has been run and the dev stack is healthy.
2. `init-idp.sh` has seeded the personas `alice@platform-eng.local`,
   `bob@platform-eng.local`, and `carol@no-team.local`.
3. The BFF (caipe-ui) is reachable at `${CAIPE_UI_URL:-http://localhost:3000}`.
4. MongoDB is reachable at `${MONGODB_URI:-mongodb://localhost:27017}`.
5. The OpenFGA store id is available as `${OPENFGA_STORE_ID}`.
6. You have a bot OBO token for the seeded test users (mint via Keycloak
   `urn:ietf:params:oauth:grant-type:token-exchange` or via the bot's
   service-account flow during local dev).

## Scripts

| Script                             | What it verifies                                                            | Source FRs        |
|------------------------------------|-----------------------------------------------------------------------------|-------------------|
| `test_slack_dm.sh`                 | Slack DM dispatch chain: deployment default → saved pref → /caipe-use → /caipe-use default | FR-023, FR-029, FR-029a |
| `test_webex_1to1.sh`               | Same chain on Webex                                                         | FR-023, FR-029    |
| `test_webui_team_grant.sh`         | Web UI chat: a team-only grant (no direct user grant) successfully dispatches | FR-038         |

Each script:

* Prints a clear PASS/FAIL marker per pin.
* Cleans up its own MongoDB state at the end (sets the user's
  the surface-specific default agent back to `null`).
* Logs the curl request bodies (with bearers redacted) when run with
  `DEBUG=1`.

## Running

```bash
export CAIPE_UI_URL="https://caipe-ui.dev.example.com"
export TEST_USER_BEARER=$(scripts/mint_test_user_token.sh alice@platform-eng.local)
export TEST_AGENT_ID="github"   # must be a real agent id in the stack

./tests/rbac/end_to_end/test_slack_dm.sh
```

Slack/Webex bot interactions that can't be driven from a shell (sending
an actual DM, invoking `/caipe-use`) are listed as **manual checkpoints**
inside each script with the exact text to send and the expected reply
prefix.
