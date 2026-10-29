# Temporary npm security backports

The UI and documentation postinstall hooks run `patch-security-dependencies.mjs`.
The UI Docker dependency stage copies this script before installing packages.

- `braces@3.0.3`: limit parser nesting to 100 brace or parenthesis blocks. This
  bounds the AST consumed by recursive compilation, expansion and stringification.
  Ordinary patterns remain compatible; excessive nesting throws `SyntaxError`.
  Advisory: [GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm).
  Upstream discussion: [micromatch/braces#70](https://github.com/micromatch/braces/issues/70).
- `node-forge@1.4.0`: validate the exact number of nested DigestAlgorithm elements
  when verifying RSA signatures, including optional algorithm parameters.
  Advisory: [GHSA-86w9-cpqp-85rv](https://github.com/advisories/GHSA-86w9-cpqp-85rv).
  Backport source: [digitalbazaar/forge#1152](https://github.com/digitalbazaar/forge/pull/1152).
- `deepmerge@4.3.1`: exclude `__proto__` from key enumeration for both merge
  operands, including nested objects and cloned array elements. Patch the source
  and both published bundles (`dist/cjs.js` and `dist/umd.js`). This blocks the
  prototype setter even when the target has a null prototype, a primitive
  placeholder, or an own `__proto__` property, while retaining symbol keys.
  Advisory: [GHSA-gcqx-w48m-w2h4](https://github.com/advisories/GHSA-gcqx-w48m-w2h4).
  Proposed upstream guards: [TehShrike/deepmerge#274](https://github.com/TehShrike/deepmerge/pull/274).

Each installed copy listed in the npm lockfile is patched. Unexpected versions
or source contents fail installation. Repeated runs verify the existing patch.
Do not use `--ignore-scripts` for production installations.

Run from `ui/` and `docs/` after `npm ci`:

```sh
node --test ../scripts/npm/*.test.mjs
```

Remove a backport and install a verified fixed version when upstream publishes
it. Lockfile scanners continue reporting the published version; these hooks
mitigate the installed code without concealing findings or altering versions.
