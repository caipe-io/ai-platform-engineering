# Keycloak init scripts — single source of truth

This directory is the **canonical** location for the two Keycloak post-install
scripts. They are consumed by:

| Consumer | How it loads them |
|----------|-------------------|
| Helm chart (`charts/.../keycloak/templates/configmap-init-scripts.yaml`) | `.Files.Get "scripts/init-*.sh"` rendered into a ConfigMap; mounted into `keycloak-init*` Jobs as `/scripts/`. |
| Docker Compose dev stack (`docker-compose.dev.yaml`) | Bind-mounts via `./deploy/keycloak/init-*.sh:/scripts/init-*.sh:ro` — `deploy/keycloak/init-*.sh` are **symlinks** that resolve back to this directory. |

## Editing rules

- **Always edit the files here.** Never replace `deploy/keycloak/init-*.sh`
  with regular files — that re-introduces drift (we already had a 776-line vs
  398-line divergence and a busybox-sed regex bug ride along for weeks).
- Both scripts must remain **busybox `sh` / `sed`** portable. The Helm Job
  and the docker-compose init containers both run inside our project image
  `caipe/keycloak-init` (built from `build/Dockerfile.keycloak-init`,
  based on Chainguard `wolfi-base`). Wolfi's `/bin/sh` and `sed` are still
  busybox-derived, so the busybox compatibility constraints below remain.
  Notable gotchas we already paid for:
  - `set +B` is a parse-time error in busybox; guard with
    `if (set +B) 2>/dev/null; then set +B; fi`.
  - busybox `sed` requires explicit `\)` to close BRE capture groups; GNU
    sed auto-closes at end of pattern but busybox aborts with
    `bad regex: Missing ')'`.
  - `python3` **is** available (~3.14) for richer JSON munging. Used by
    `init-idp.sh` to update the realm user profile with the
    `slack_user_id` attribute. Don't add other heavy runtime deps —
    `apk add` more packages in `build/Dockerfile.keycloak-init` if you
    truly need them and document why.

## Verifying after a change

```bash
# 1) busybox parse + smoke test
docker run --rm \
  -v "$(pwd)/charts/ai-platform-engineering/charts/keycloak/scripts/init-idp.sh:/s.sh:ro" \
  alpine/curl:latest /bin/sh -n /s.sh

# 2) Helm renders both scripts into the ConfigMap unchanged
helm template kc charts/ai-platform-engineering/charts/keycloak \
  --show-only templates/configmap-init-scripts.yaml | grep '#!/bin/sh'

# 3) Docker compose still sees the canonical content via symlink
diff -q deploy/keycloak/init-idp.sh charts/ai-platform-engineering/charts/keycloak/scripts/init-idp.sh
diff -q deploy/keycloak/init-token-exchange.sh charts/ai-platform-engineering/charts/keycloak/scripts/init-token-exchange.sh
```
