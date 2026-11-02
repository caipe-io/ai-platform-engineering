# Standalone configuration bridge

- The bridge polls the BFF target API and publishes `/mcp/<id>` routes to the
  shared configuration file. Existing authentication policies are preserved.
- AgentGateway's `/config` endpoint returns the desired file, including changes
  that the proxy rejected. `/config_dump` exposes the installed runtime binds.
- After publication, the bridge compares public MCP route paths in the runtime
  dump with the desired paths. Internal `/mcp//...` subroutes are excluded.
- A failed reload, for example during a temporary JWKS outage, leaves the previous
  routes installed. The bridge republishes the same configuration atomically to
  trigger another reload, using delays of 5, 10, 20, 40, then at most 60 seconds.
  Recovery resets the backoff. An unavailable or malformed runtime dump does not
  acknowledge installation or trigger blind reloads.

## Diagnostics

- `.reconcile_ok` retains its bootstrap/publication semantics for Compose startup.
- `.runtime_ready` is a diagnostic marker for the last successful public path
  comparison. Pending routes or unavailable admin/BFF responses clear it. It does
  not control Kubernetes Pod readiness or withdraw existing working routes.
- Public path convergence does not verify a complete policy/backend generation or
  upstream reachability. Continue using end-to-end MCP probes for those failures.
- Logs identify missing/unexpected paths when a reload is retried; reconcile
  results include `runtime_ready` and `reload_retried`.

Run bridge tests with `uv run pytest deploy/agentgateway/tests/test_config_bridge.py`.
