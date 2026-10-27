# Deployment-owned OpenFGA models

Use `openfga.init.existingModelConfigMap` to supply a complete authorization model
without forking the chart or replacing its initialization script.

```yaml
openfga:
  init:
    existingModelConfigMap: example-authorization-model
```

- The ConfigMap must exist in the release namespace and contain the key
  `authorization-model.json` with valid OpenFGA model JSON.
- Manage it in GitOps, or create it before running Helm. With Argo CD, render it
  as a normal Sync resource, before the chart's post-install/post-upgrade hook.
- An empty value uses the bundled model, unchanged.
- Only the JSON is projected from the external ConfigMap. `seed.py`, store
  discovery, configured seed tuples and platform-client seeding remain chart-owned.
- A missing ConfigMap/key prevents the Job from starting. Invalid model JSON or
  a model rejected by OpenFGA fails initialization; there is no fallback to the
  bundled model.
- This does not change Compose initialization or grant an app authority to alter
  the model. Only trusted deployment administrators should manage this ConfigMap.

## Release and authorization safety

- Start with the model from the **exact CAIPE chart release** and apply reviewed
  extensions. Supply the complete model, not a fragment.
- On every upgrade, regenerate the composition from the new release. A stale
  override can omit new platform authorization types and relations.
- Validate both the complete model and existing private/team/global access
  behavior before promotion. Review inherited access as an authorization change.
- Use one initialization owner per store; do not run competing model publishers.
- Models are immutable versions. The current initializer publishes a new version
  on each hook run; this setting changes its model source, not that lifecycle.
- Publishing a model does not rewrite relationship tuples. Removing relations
  can nevertheless invalidate those tuples for future checks and writes.
- Keep the previous model and source revision for rollback; review model and
  application compatibility together. Reverting to the bundled model is not a
  safe rollback if deployed apps still require extension relations.
- Clients following the latest model will observe publications automatically;
  explicitly pinned clients require coordinated model-ID updates.

## Composing app-owned policies

- OpenFGA modular models can keep platform and application policies in separate
  source files. Compile and validate them into **one complete model** before
  creating the deployment ConfigMap. This setting accepts that build artifact;
  it does not perform model merging in Helm or in the running server.
- Authorization checks select one model version. Publishing a second app model
  does not layer its relations over the platform model.
- Modular `extend type` adds new relations; it cannot redefine an existing
  relation. Changing a shared permission expression requires explicit platform
  ownership and review, or an app-specific type with a coordinated tuple migration.
- An application manifest may advertise policy requirements, but must not
  automatically install or grant them. Deployment approval remains the boundary.

See [OpenFGA modular models](https://openfga.dev/docs/modeling/modular-models).
