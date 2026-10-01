# CAIPE native extension SDK

Version `1.1.1` checks contract `1.1` packages. The checker is intentionally
dependency-free at runtime; the type declarations use the host's React and
Next.js peer dependencies.

Publisher CI can install a pinned SDK tarball from a supported CAIPE release
and run `caipe-native-check ./native-package` after compiling the app. Run the
same check against each host release the package claims to support. The CLI
checks manifest ownership syntax, client-only exports, shared peer runtimes,
compiled browser code, CSS document selectors, and bundle budgets. The CAIPE
host also checks cross-package route/API/slot collisions and lockfile integrity
when building the final image.

Contract additions keep the `1.1` interface compatible; a breaking interface
change requires a new contract version and a matching SDK major version.
