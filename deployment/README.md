# Declarative Compose profiles

Compose profiles are flat YAML selectors consumed by `setup-caipe.sh`; the
script deliberately does not require `yq` or Python just to bootstrap Docker.
Keep credentials in `env_file` and certificate material in protected files.

```bash
./setup-caipe.sh compose \
  --config deployment/sandbox.example.yaml \
  --env-file ~/.config/caipe/sandbox.env \
  --wait --validate
```

Supported profile keys include:

- `compose_files`, `profiles`, `env_file`, `domain`, `ui_url`, `ports`
- `tls_cert`, `tls_key`, `required_env`, `required_files`
- `rag`, `scheduler`, `tome`, `weather`, `webex`, `webex_meetings`
- `github_enterprise`, `github_enterprise_host`, `litellm`, `duo_only`
- `nextauth_url`, `sso_issuer`, `sso_client_id`, `sso_group_claim`,
  `required_group`, `admin_group`, `bootstrap_admins`, `scheduler_url`, and
  `litellm_endpoint`

Commands:

- `plan` renders and validates the selected files without starting containers.
- `compose` starts the stack; `--wait` and `--validate` enable verification.
- `repair` reconciles containers and writes `.caipe/setup-state.json`.
- `status` shows the rendered Compose stack when a Compose profile is selected.

Feature backends are checked before startup. For example, enabling
`scheduler: true` fails unless the rendered project contains a
`caipe-scheduler` service.
