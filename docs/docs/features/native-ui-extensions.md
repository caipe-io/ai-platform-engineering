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
  "contractVersion": "1.0",
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
  }
}
```

```ts
export interface NativeExtensionProps {
  apiBasePath: string;
  pathname: string;
  search: string;
  navigate(href: string): void;
  setBreadcrumbs(items: Array<{ label: string; href?: string }>): void;
}

export default {
  contractVersion: "1.0",
  Component,
};
```

The package must expose `.` for its ESM entry, `./manifest` for the JSON
manifest, and `./styles.css` for scoped styles. React, React DOM, Next.js,
NextAuth, and next-themes must remain peer dependencies so the host supplies
one copy.

## Build and routing

1. Install reviewed packages in the derived CAIPE image.
2. Set `CAIPE_NATIVE_EXTENSION_MODULES` to a comma-separated package list.
3. Run the normal UI build. The prebuild generator validates ownership and
   emits static imports, manifest data, and Tailwind source declarations.
4. CAIPE rewrites claimed browser paths to its internal native host while the
   public URL stays unchanged. Client navigation keeps the host and extension
   mounted in one React tree.

Package manifests cannot claim CAIPE internal paths. Overlapping host or API
claims fail the build.

## Authentication and authorization

The browser continues to hold only the CAIPE session. Claimed API paths are
rewritten to the existing External App gateway, which:

- authenticates the CAIPE session;
- evaluates the configured app policy;
- mints a short-lived, audience-bound user JWT;
- forwards the stable user subject and trusted roles; and
- returns decision and correlation IDs.

The extension never receives the CAIPE session cookie or raw OIDC token. Its
service remains responsible for resource authorization, such as OpenFGA
checks using the forwarded user subject.

## Performance marks

The host emits `caipe-native-extension:<id>:route-ready`. Packages should emit
their own render-ready and data-ready marks so browser benchmarks can separate
shell routing, bundle execution, and API latency.
