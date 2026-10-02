# CAIPE native extension SDK

Version `1.1.2` checks contract `1.1` packages. The checker is intentionally
dependency-free at runtime; the type declarations use the host's React and
Next.js peer dependencies.

Publisher CI can install a pinned SDK tarball from a supported CAIPE release
and run `caipe-native-check ./native-package` after compiling the app. Run the
same check against each host release the package claims to support. The CLI
checks manifest ownership syntax, client-only exports, shared peer runtimes,
compiled browser code, CSS document selectors, and bundle budgets. The CAIPE
host also checks cross-package route/API/slot collisions and lockfile integrity
when building the final image.

An optional `assistant` claim (`agentId`, `label`, `name`) lets the host render
its own floating chat for a config-driven agent. The host fetches the agent
through its RBAC-protected API and sends bounded route context with turns. The
app must seed the agent and its MCP server separately; the native package does
not receive credentials or create agents at runtime.

Contract additions keep the `1.1` interface compatible; a breaking interface
change requires a new contract version and a matching SDK major version.
