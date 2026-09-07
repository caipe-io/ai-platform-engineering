# Authentication Overview

This page provides a conceptual overview of authentication and authorization in CAIPE RAG. For configuration details and environment variables, see the [Server README](https://github.com/caipe-io/ai-platform-engineering/tree/main/ai_platform_engineering/knowledge_bases/rag/server/README.md).

## Authentication Methods

CAIPE RAG supports multiple authentication methods to accommodate different deployment scenarios:

| Method | Use Case | How It Works |
|--------|----------|--------------|
| **JWT Bearer Token** | Production | Validates tokens against OIDC provider |
| **OAuth2 Client Credentials** | Ingestors | Machine-to-machine authentication |

### JWT Bearer Token (Production)

The recommended authentication method for production deployments. Users authenticate through your OIDC provider (Keycloak, Okta, Azure AD, AWS Cognito, etc.) and the RAG server validates their JWT tokens.

**Flow:**
1. User authenticates with OIDC provider via UI
2. UI receives JWT access token
3. UI includes token in `Authorization: Bearer <token>` header
4. RAG server validates token:
   - Signature verification against OIDC provider's JWKS
   - Expiry (`exp`), not-before (`nbf`), issued-at (`iat`) claims
   - Audience (`aud`) matches configured `OIDC_AUDIENCE`
   - Issuer (`iss`) matches configured `OIDC_ISSUER`
5. Server records identity claims for audit and OpenFGA subject resolution
6. Server checks OpenFGA for resource-level authorization

### OAuth2 Client Credentials (Ingestors)

Ingestors use OAuth2 client credentials flow for machine-to-machine authentication. This doesn't involve a user - the ingestor authenticates as a service account.

**Flow:**
1. Ingestor requests token from OIDC provider using client ID/secret
2. Ingestor includes token in API requests
3. RAG server validates token against ingestor OIDC configuration
4. Server assigns configured role (default: `ingestonly`)

## Token Type Detection Flow

After validating the JWT token, the server determines whether it's a **user token** (SSO) or **client credentials token** (machine-to-machine):

```
┌─────────────────────────────────────────────────────────────────────┐
│                    VALIDATE ACCESS TOKEN                             │
│  ✓ Signature (JWKS)  ✓ exp  ✓ nbf  ✓ iat  ✓ aud  ✓ iss             │
└─────────────────────────────┬───────────────────────────────────────┘
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│  Check: grant_type == "client_credentials"?                          │
└──────────────────────┬──────────────────────────────────────────────┘
                       │
          ┌────────────┴────────────┐
          │ YES                     │ NO
          ▼                         ▼
┌─────────────────┐    ┌──────────────────────────────────────────────┐
│ CLIENT CREDS    │    │  Check: has client_id/azp but NO user claims? │
│ (skip to role)  │    │  (email, preferred_username, upn, name)       │
└─────────────────┘    └──────────────────────┬───────────────────────┘
                                              │
                              ┌───────────────┴───────────────┐
                              │ YES                           │ NO
                              ▼                               ▼
               ┌─────────────────┐           ┌────────────────────────┐
               │ CLIENT CREDS    │           │  Check: token_use ==   │
               │ (skip to role)  │           │  "client_credentials"? │
               └─────────────────┘           └───────────┬────────────┘
                                                         │
                                         ┌───────────────┴───────────┐
                                         │ YES                       │ NO
                                         ▼                           ▼
                          ┌─────────────────┐       ┌─────────────────────┐
                          │ CLIENT CREDS    │       │  Check: sub is UUID │
                          │ (skip to role)  │       │  AND no user claims?│
                          └─────────────────┘       └──────────┬──────────┘
                                                               │
                                               ┌───────────────┴───────────┐
                                               │ YES                       │ NO
                                               ▼                           ▼
                                ┌─────────────────┐         ┌──────────────────┐
                                │ CLIENT CREDS    │         │ USER TOKEN (SSO) │
                                │ (skip to role)  │         │ → OpenFGA authz  │
                                └─────────────────┘         └──────────────────┘
```

### Client Credentials Path

When detected as client credentials:
- **Role**: Assigned `RBAC_CLIENT_CREDENTIALS_ROLE` (default: `ingestonly`)
- **Groups**: Empty (not applicable for machine tokens)
- **Email**: Set to `client:{client_id}` or `client:{ingestor_type}:{ingestor_name}`

### User Token (SSO) Path

When detected as a user token:
- Extracts identity claims (`sub`, email) from the validated access token
- Uses `user:<sub>` for OpenFGA checks on knowledge bases and related resources
- Does not map Keycloak realm roles or groups into RAG permissions

### Detection Criteria Summary

| Check | Claim | Indicates Client Credentials |
|-------|-------|------------------------------|
| 1 | `grant_type == "client_credentials"` | Yes |
| 2 | Has `client_id`/`azp` but no `email`/`preferred_username`/`upn`/`name` | Yes |
| 3 | `token_use == "client_credentials"` | Yes |
| 4 | `sub` is UUID format AND no user claims | Yes |
| 5 | None of the above | No → User token |

## RAG Authorization

CAIPE RAG keeps the role names for service-client compatibility, but human user authorization is OpenFGA-based:

| Role | Capabilities |
|------|--------------|
| **readonly** | Authenticated human baseline; resource access still requires OpenFGA |
| **ingestonly** | Service clients that ingest data and manage ingestion jobs |
| **admin** | Administrative service clients |

### Role Assignment Priority

When determining authorization, the server checks in order:

1. **Client credentials** - Service-account tokens receive `RBAC_CLIENT_CREDENTIALS_ROLE`.
2. **Human users** - Valid OIDC user tokens receive an authenticated baseline and resource access is checked in OpenFGA.
3. **Unsafe emergency bypass** - `CAIPE_UNSAFE_RBAC_BYPASS=true` temporarily bypasses RAG KB checks and should not be used in production.

### Actor Types

| Actor | Authentication | Default Role | Role Source |
|-------|---------------|--------------|-------------|
| **User** | JWT Bearer | `readonly` baseline | OpenFGA `user:<sub>` relationships |
| **Ingestor** | Client Credentials | `ingestonly` | `RBAC_CLIENT_CREDENTIALS_ROLE` |

## Supported OIDC Providers

CAIPE RAG works with any OIDC-compliant provider:

- Keycloak
- Okta
- Azure AD (Entra ID)
- AWS Cognito
- Auth0
- Google Workspace

The server automatically discovers OIDC endpoints from the issuer URL and validates tokens using the provider's public keys.

## Identity Claims

For human users, the RAG server uses the validated access token as identity input only. The stable `sub` claim becomes the OpenFGA subject (`user:<sub>`), while email is used for display and audit context.

### Identity Resolution Flow

```
┌─────────────────────────────────────────────────────────────────────┐
│                    VALIDATE ACCESS TOKEN                             │
│  ✓ Signature (JWKS)  ✓ exp  ✓ nbf  ✓ iat  ✓ aud  ✓ iss             │
└─────────────────────────────┬───────────────────────────────────────┘
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│  Extract 'sub' (subject identifier) from access token               │
│  Used as the OpenFGA subject: user:<sub>                            │
└──────────────────────┬──────────────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────────────┐
└──────────────────────┬──────────────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────────────┐
│  Extract email / preferred_username / upn for display and audit      │
└──────────────────────┬──────────────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────────────┐
│  Authorize resource access through OpenFGA relationships             │
└─────────────────────────────────────────────────────────────────────┘
```

### Why Not Userinfo or Realm Roles?

RAG authorization is now relationship-based. Keycloak/SSO proves identity, and OpenFGA answers whether that identity can read, ingest, or manage a specific knowledge base. This avoids relying on stale realm-role mirroring or provider-specific group claims.

### Email Extraction Priority

When extracting the user's display email from token claims, the server checks these claims in order:

| Priority | Claim | Description |
|----------|-------|-------------|
| 1 | `email` | Standard OIDC claim |
| 2 | `preferred_username` | Common in Keycloak, Azure AD |
| 3 | `upn` | User Principal Name (Microsoft) |
| 4 | `sub` | Subject identifier (last resort, usually opaque) |

The first non-empty value is used. If all are empty, defaults to `"unknown"`.

> **Note:** When `sub` is used as a fallback, the email may appear as an opaque hash. This is logged as a warning but doesn't affect authorization because OpenFGA uses the stable subject identifier.

## Security Best Practices

### Production Deployments

- Use JWT Bearer authentication with your OIDC provider
- Keep `OPENFGA_HTTP` configured when RAG team scope is enabled
- Use OpenFGA tuples for KB read/ingest/manage relationships
- Rotate OIDC client secrets regularly
- Monitor authentication failures in logs

### Development Deployments

- Use `CAIPE_UNSAFE_RBAC_BYPASS=true` only as a short-lived local emergency escape hatch
- Test with production-like OIDC configuration before deploying

### What to Avoid

- Never grant human RAG access through Keycloak realm roles
- Never commit OIDC secrets to version control
- Require bearer-token authentication for RAG identity and data endpoints

## Further Reading

- [Server README](https://github.com/caipe-io/ai-platform-engineering/tree/main/ai_platform_engineering/knowledge_bases/rag/server/README.md) - Configuration reference with all environment variables
- [Ingestors](ingestors.md) - Ingestor authentication setup
- [Architecture](architecture.md) - System architecture overview
