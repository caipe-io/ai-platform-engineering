---
title: Trusted native UI extensions
---

# Trusted native UI extensions

Native UI extensions let first-party teams ship a React surface in the CAIPE
shell without an iframe. They are installed while building a CAIPE image, but
the feature code and release history stay in the team's repository.

Use this mode only for reviewed, trusted code. A native package shares the
CAIPE document, React runtime, browser storage, and same-origin privileges.
Use an External App iframe when those privileges are not appropriate.

## Package contract

Each package exports a component and a JSON manifest:

```json
{
  "id": "example-app",
  "displayName": "Example App",
  "description": "Example first-party workspace",
  "contractVersion": "1.1",
  "hostPaths": ["/example"],
  "navigation": {
    "label": "Example",
    "href": "/example",
    "placement": "after-chat",
    "icon": "layout-grid"
  },
  "api": {
    "appId": "example-app",
    "basePath": "/api/agentic-apps/runtime/example-app",
    "mounts": ["/api/example"]
  },
  "auth": { "mode": "app-scoped-token" }
}
```

```ts
export interface NativeExtensionProps {
  apiBasePath: string;
  pathname: string;
  search: string;
  navigate(href: string): void;
  Link?: typeof import("next/link").default;
  setBreadcrumbs(items: Array<{ label: string; href?: string }>): void;
}

export default {
  contractVersion: "1.1",
  Component,
};
```

The package must expose `.` for its ESM entry, `./manifest` for the JSON
manifest, and `./styles.css` for scoped styles. React, React DOM, Next.js,
NextAuth, and next-themes must remain peer dependencies so the host supplies
one copy.
The package may not export a server entry or run install-time code. Its entry
must be compiled browser JavaScript beginning with `"use client"`; the checker
rejects server-only imports. App APIs, MCP endpoints, ingestion, and agents
remain separately deployed services.

`navigation` is optional. An app with owned routes but no navigation item can
be opened only through an authorized deep link or another host surface. A
route-less app can instead declare `"hostPaths": []` and `"slots": ["home"]`;
the host mounts that component on the home page. Every app must claim at least
one route or supported slot. Slots, routes, and API mounts are exclusive across
installed packages.
For a non-advertised internal app, the Agentic App installation may set
`visible: false`: the native route/slot and gateway still enforce installed,
enabled, session, role, and API policy checks, while the public app catalog
remains hidden. This visibility exception applies only to compiled native apps.

## Build and routing

1. Build the package and run the host conformance checker against its package
   directory: `node ui/scripts/check-native-extension.mjs <package-directory>`.
   It verifies the manifest, export targets, contract version, and shared
   runtime peer dependencies. Publisher CI should run the same checker against
   each supported CAIPE host release. Checker `1.1.1` also enforces a 64 KiB
   entry budget, a 2 MiB compiled-JavaScript budget, and rejects document-wide
   CSS selectors. These are uncompressed publisher gates, not network latency
   estimates. Apps can lazy-load editor and visualization chunks.
2. Install a reviewed package at an **exact version** in the derived CAIPE image,
   or install its immutable `.tgz` artifact. Commit the resulting `package-lock.json`
   in the derived build context; the host build rejects missing integrity data,
   version mismatches, and floating dependency ranges.
   For tarballs, place the artifact in `ui/native-extension-artifacts/` and
   install it with `npm install --save-exact ./native-extension-artifacts/<name>.tgz`.
3. Set `CAIPE_NATIVE_EXTENSION_MODULES` to a comma-separated allowlist of
   packages already installed in the image. This is a build-time selection,
   not a browser-controlled or runtime remote-JavaScript loader.
4. Run the normal UI build. The prebuild generator validates ownership and
   emits static imports, manifest data, and Tailwind source declarations.
   Docker builds must pass the package list as the
   `CAIPE_NATIVE_EXTENSION_MODULES` build arg (a runtime environment variable
   alone cannot bake the module into the image).
5. CAIPE rewrites claimed browser paths to its internal native host while the
   public URL stays unchanged. Client navigation keeps the host and extension
   mounted in one React tree. Use the optional host `Link` for ordinary links
   (or `navigate` for imperative transitions); direct `next/link` is compatible
   only when it resolves to the host-provided Next singleton. Links to owned
   routes should use canonical browser paths, including on direct loads.

Package manifests cannot claim CAIPE internal paths. Overlapping route, slot,
or API claims fail the build. An image rollback restores the prior pinned
package and host combination; runtime enablement cannot install new code.
The host reserves its built-in sections; `/projects` is an intentional
extension point and can be claimed by one package at build time.

## Authentication and authorization

The browser continues to use the CAIPE session. Claimed API paths are
rewritten to the existing External App gateway, which authenticates that
session, evaluates the configured app policy, and applies the manifest's
explicitly declared authentication mode. The installed app configuration must
agree with that mode or the gateway fails closed.

In the default `app-scoped-token` mode the gateway:

- mints a short-lived, audience-bound user JWT;
- forwards the stable user subject and trusted roles; and
- returns decision and correlation IDs.

The gateway is a browser-cookie ingress. It obtains a CAIPE session, ignores
caller-supplied identity headers, and is not the machine-to-machine API for an
extension. Bearer clients, webhooks, and MCP callers use an app-owned ingress
that independently validates their token and scopes. Neither app should treat
`x-caipe-roles` or another forwarding header as proof of authorization.

Trusted deployments may opt into `forward-user-access-token` when the target
service validates that token's issuer and audience. The gateway forwards the
existing access token server-to-server; the native-package contract does not
pass it as a component prop. CAIPE's current NextAuth session callback also
exposes `accessToken` to first-party browser code, so a trusted native package
is **not** an isolation boundary for that token. In both modes, the service
remains responsible for resource-level
authorization, such as OpenFGA checks using the stable user subject. Native
JavaScript shares the CAIPE document and same-origin privileges, so package
review is part of the security boundary.

Record the package tarball digest, source commit, CAIPE commit, checker version,
and image tag in the deployment record. Roll back the entire pinned host image;
changing runtime enablement cannot roll back compiled JavaScript by itself.

## Performance marks

The host emits `caipe-native-extension:<id>:route-ready`. Packages should emit
their own render-ready and data-ready marks so browser benchmarks can separate
shell routing, bundle execution, and API latency.
