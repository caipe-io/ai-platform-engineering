---
sidebar_position: 1
id: 069-github-app-authentication-architecture
sidebar_label: Architecture
---

# Architecture: GitHub App Authentication for the GitHub Agent

**Date**: 2026-02-10

## How It Works

```mermaid
sequenceDiagram
    participant Agent as GitHub Agent
    participant Provider as TokenProvider
    participant GitHubAPI as GitHub API

    Agent->>Provider: get_github_token()
    alt Token cached and valid
        Provider-->>Agent: Return cached token
    else Token expired or missing
        Provider->>Provider: Generate JWT from private key
        Provider->>GitHubAPI: POST /app/installations/{id}/access_tokens
        GitHubAPI-->>Provider: Installation token (60 min)
        Provider->>Provider: Cache token
        Provider-->>Agent: Return fresh token
    end
    Agent->>GitHubAPI: Use token for MCP / gh CLI / git
```

The token provider generates a JWT from the App's private key, exchanges it for a 60-minute installation token via the GitHub API, caches it in memory, and transparently refreshes it 5 minutes before expiry. All of this is thread-safe and happens automatically.

---


## GitHub App vs PAT Comparison

| | GitHub App | Personal Access Token |
|---|---|---|
| **Token lifetime** | 60 minutes (auto-refreshed) | 30-90 days (manual rotation) |
| **Rotation** | Automatic | Manual |
| **Credentials** | Private key (never expires) | Token string (expires) |
| **Audit trail** | `github-app/caipe-github-agent` | Appears as your user account |
| **Scope** | Per-installation (org/repo level) | Per-user |
| **Offboarding risk** | None (not tied to a person) | Breaks when user leaves |
| **Org policy** | Admins control via App settings | PATs often restricted |

---


## Step 1: Create the GitHub App

1. Navigate to your organization's app settings:

   ```
   https://github.com/organizations/YOUR_ORG/settings/apps/new
   ```

   For personal accounts, use `https://github.com/settings/apps/new`.

2. Fill in the form:

   | Field | Value |
   |-------|-------|
   | **GitHub App name** | `caipe-github-agent` (must be globally unique) |
   | **Homepage URL** | `https://github.com/caipe-io/ai-platform-engineering` |
   | **Webhook** | Uncheck **Active** (not needed) |

3. Set **Repository permissions**:

   | Permission | Access | Purpose |
   |------------|--------|---------|
   | **Contents** | Read | Read repo files, commits, branches |
   | **Issues** | Read and write | Create and manage issues |
   | **Pull requests** | Read and write | Create and manage PRs |
   | **Actions** | Read | View workflow runs and logs |
   | **Metadata** | Read | Required (auto-selected) |

   Optionally, under **Organization permissions**:

   | Permission | Access | Purpose |
   |------------|--------|---------|
   | **Members** | Read | List org teams and members |

4. Under **Where can this GitHub App be installed?**, select **Only on this account**.

5. Click **Create GitHub App**.

---


## Step 2: Collect the Three Credentials

After creating the app, you need three values:

### App ID

Found at the top of the app settings page after creation. It is a number like `12345`.

### Private Key

1. On the app settings page, scroll to **Private keys**
2. Click **Generate a private key**
3. A `.pem` file downloads automatically
4. Store this file securely (it is the only credential that authenticates your app)

### Installation ID

1. Go to **Install App** in the left sidebar of the app settings
2. Click **Install** next to your organization
3. Choose **All repositories** or **Only select repositories**
4. Click **Install**
5. The URL after installation contains the Installation ID:

   ```
   https://github.com/organizations/YOUR_ORG/settings/installations/67890
                                                                     ^^^^^
                                                              Installation ID
   ```

   Alternatively, use the API:

   ```bash
   gh api /orgs/YOUR_ORG/installations --jq '.installations[].id'
   ```

---


## Step 3: Configure Environment Variables

You need to set three environment variables:

```
GITHUB_APP_ID=12345
GITHUB_APP_PRIVATE_KEY=<PEM key contents>
GITHUB_APP_INSTALLATION_ID=67890
```

The private key can be provided in three formats:

### Option A: File Path (recommended for local development)

```env
GITHUB_APP_ID=12345
GITHUB_APP_PRIVATE_KEY_PATH=/path/to/caipe-github-agent.private-key.pem
GITHUB_APP_INSTALLATION_ID=67890
```

### Option B: Inline PEM (for `.env` files and docker-compose)

Convert newlines to `\n`:

```bash
awk 'NF {sub(/\r/, ""); printf "%s\\n",$0;}' caipe-github-agent.private-key.pem
```

Then set in your `.env`:

```env
GITHUB_APP_ID=12345
GITHUB_APP_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\nMIIE...\n...\n-----END RSA PRIVATE KEY-----"
GITHUB_APP_INSTALLATION_ID=67890
```

### Option C: Base64-encoded (for secrets managers)

```bash
base64 < caipe-github-agent.private-key.pem
```

```env
GITHUB_APP_ID=12345
GITHUB_APP_PRIVATE_KEY=LS0tLS1CRUdJTi...
GITHUB_APP_INSTALLATION_ID=67890
```

### Docker Compose

The `docker-compose.dev.yaml` already passes these variables to the `agent-github` service:

```yaml
environment:
  - GITHUB_APP_ID=${GITHUB_APP_ID:-}
  - GITHUB_APP_PRIVATE_KEY=${GITHUB_APP_PRIVATE_KEY:-}
  - GITHUB_APP_INSTALLATION_ID=${GITHUB_APP_INSTALLATION_ID:-}
```

### Helm / External Secrets (Kubernetes)

The `values-external-secrets.yaml` includes all three secrets under `agent-github`:

```yaml
agent-github:
  agentSecrets:
    secretName: "external-github-secret"
    externalSecrets:
      data:
      - secretKey: GITHUB_APP_ID
        remoteRef:
          key: dev/github
          property: GITHUB_APP_ID
      - secretKey: GITHUB_APP_PRIVATE_KEY
        remoteRef:
          key: dev/github
          property: GITHUB_APP_PRIVATE_KEY
      - secretKey: GITHUB_APP_INSTALLATION_ID
        remoteRef:
          key: dev/github
          property: GITHUB_APP_INSTALLATION_ID
```

Store the three values in your secrets backend (e.g., AWS Secrets Manager at `dev/github`).

---


## Step 4: Verify

### Startup Logs

When the GitHub agent starts, it logs its auth mode:

| Log Message | Meaning |
|---|---|
| `GitHub App auth: token obtained (length=...)` | App auth working |
| `GitHub auth: using static PAT` | Falling back to PAT |
| `GitHub App auth: failed to obtain token - ...` | App configured but broken |
| `GitHub auth: no credentials configured` | Nothing set |

### Health Endpoint

```bash
curl http://localhost:8001/healthz | python -m json.tool
```

**GitHub App mode (healthy):**

```json
{
    "status": "healthy",
    "agent": "github",
    "timestamp": 1739161800,
    "github_auth": {
        "auth_mode": "github_app",
        "has_token": true,
        "expires_at_utc": "2026-02-10T01:30:00+00:00",
        "expires_in_seconds": 3245,
        "status": "healthy"
    }
}
```

**PAT mode:**

```json
{
    "status": "healthy",
    "agent": "github",
    "timestamp": 1739161800,
    "github_auth": {
        "auth_mode": "pat",
        "has_token": true,
        "status": "healthy"
    }
}
```

**No credentials (HTTP 503):**

```json
{
    "status": "unhealthy",
    "agent": "github",
    "timestamp": 1739161800,
    "github_auth": {
        "auth_mode": "none",
        "has_token": false,
        "status": "no_credentials"
    }
}
```

### Additional Endpoints

| Endpoint | Purpose | Response |
|----------|---------|----------|
| `GET /health` | Liveness probe | `{"status": "ok"}` (always 200) |
| `GET /ready` | Readiness probe | 200 if token available, 503 if not |
| `GET /healthz` | Detailed health with token expiry | See examples above |

---


## Fallback Behavior

If GitHub App credentials are not set, the agent falls back to `GITHUB_PERSONAL_ACCESS_TOKEN` automatically. No code changes are needed for existing PAT-based deployments.

The token resolution priority is:

1. GitHub App installation token (if `GITHUB_APP_ID` + `GITHUB_APP_PRIVATE_KEY` + `GITHUB_APP_INSTALLATION_ID` are set)
2. `GITHUB_PERSONAL_ACCESS_TOKEN` environment variable
3. `GITHUB_TOKEN` environment variable
4. No authentication (agent will report errors)

---


## Troubleshooting

| Problem | Cause | Solution |
|---------|-------|---------|
| `403 Resource not accessible by integration` | App missing permissions | Add required permissions in App settings, then re-install |
| `401 Bad credentials` | Wrong App ID or private key | Verify `GITHUB_APP_ID` matches the app, regenerate private key |
| `404 Not Found` on token exchange | Wrong Installation ID | Check `/organizations/ORG/settings/installations` for correct ID |
| Token refresh fails intermittently | Network issues to `api.github.com` | Provider retries on next call, falls back to PAT if available |
| `get_me` returns 403 | GitHub App tokens don't support `/user` endpoint | The `context` toolset calls `get_me`; this is a known GitHub MCP limitation for App tokens |

---


## Related

- Spec: [spec.md](./spec.md)
