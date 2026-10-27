# Keycloak OAuth Server Setup

This directory starts a local Keycloak server for CAIPE development. The
canonical realm export and init scripts live under the Helm chart; this
directory keeps Docker Compose-friendly symlinks to those files.

## Init Scripts

`init-idp.sh` and `init-token-exchange.sh` are symlinks into:

```text
charts/ai-platform-engineering/charts/keycloak/scripts/
```

- Edit the canonical chart files only.
- Keep scripts busybox-`sh`/`sed` portable.
- Docker Compose resolves the host symlink before mounting.
- Helm reads the chart-local files through `.Files.Get`.

## Realm Import

Docker Compose mounts:

```text
charts/ai-platform-engineering/charts/keycloak/realm-config.json
```

Do not create `deploy/keycloak/realm-config.json`; a missing bind-mount target
can become a directory, which causes Keycloak to start with only the `master`
realm.

## Quick Start

```bash
cd deploy/keycloak
docker compose up
```

Admin console:

- URL: http://localhost:7080
- Username: `admin`
- Password: `admin`

Switch to the `caipe` realm after login.

## Developer authentication

From the repository root on macOS or Linux, with Python 3 and Docker Compose 2.24.4 or later:

```bash
cp .env.example .env  # First setup only; configure your LLM settings in .env.
make dev-auth-up
make dev-login
make dev-api DEV_API_ARGS='/api/dynamic-agents'
make dev-auth-status
make dev-logout
```

- `dev-auth-up` starts Keycloak, OpenFGA and MongoDB, waits for auth initialization, provisions accounts, then starts the UI/runtime. Its opt-in override enables Keycloak SSO and disables anonymous/RBAC bypass flags. The UI is at `http://localhost:3000`.
- Accounts `test-user@example.test` and `test-admin@example.test` are created only by the explicitly invoked developer helper. Passwords are random and saved in the displayed private `users.json` file. Open that file locally to sign in; do not commit it.
- Existing managed accounts keep their passwords. An existing unmanaged account with either username stops setup rather than being overwritten.
- `test-admin@example.test` uses the existing UI bootstrap-admin and OpenFGA reconciliation path. Regular users receive the normal member baseline on login; resource-specific access still uses the existing permission checks.
- `dev-login` uses the existing **public `caipe-cli` client**, authorization code + PKCE S256, and a callback bound to `127.0.0.1:8085`. No client secret or user password is sent to the helper.
- Tokens are stored outside the checkout under `${XDG_STATE_HOME:-~/.local/state}/caipe/dev-auth`, with directory mode `0700` and file mode `0600`. Access tokens refresh automatically; rotated refresh tokens are saved atomically under a file lock.
- `dev-api` sends the actual user JWT to the UI gateway. The gateway supplies `X-User-Context`; the helper does not invent users, admin flags, or context headers. Streaming responses are relayed as they arrive.
- `DEBUG` controls diagnostics/reload. Unit tests can override auth dependencies; application development uses Keycloak.

### Existing local stacks and custom ports

The full startup target uses the canonical local ports and container names. For an already running stack, apply the equivalent SSO/bootstrap settings to that stack and run only the user/login helpers. Do not run the startup target against unrelated containers using the same names or ports.

```bash
export DEV_AUTH_ISSUER=http://localhost:7081/realms/caipe
export DEV_AUTH_UI_URL=http://localhost:3300
make dev-auth-users
python3 scripts/dev_auth.py login --user test-user
python3 scripts/dev_auth.py api /api/dynamic-agents
```

Global options `--issuer`, `--client-id`, `--ui-url`, and `--state-dir` go before the subcommand. Login options include `--no-browser`, `--user`, `--callback-port`, and `--timeout`. Custom callback ports must be allowed on the Keycloak CLI client. The helper accepts loopback issuers/UI URLs only.

User setup reads `KEYCLOAK_ADMIN` / `KEYCLOAK_ADMIN_PASSWORD` from the process environment, defaulting to the canonical local admin credentials. It does not source `.env` into the shell. The local override deliberately configures the standard development client secrets and Keycloak issuer, clears upstream group-login requirements, and uses OpenFGA for resource access. Use a separate local stack when production-like settings are required.

The helper reuses the CLI client reconciled by the canonical init scripts. Run `make rbac-reinit` on older local realms if that client is missing. CLI login never enables direct grants or service accounts on this public client.
