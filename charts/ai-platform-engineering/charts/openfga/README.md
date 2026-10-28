# openfga

![Version: 1.3.0-rc.9](https://img.shields.io/badge/Version-1.3.0--rc.9-informational?style=flat-square) ![Type: application](https://img.shields.io/badge/Type-application-informational?style=flat-square) ![AppVersion: 1.3.0-rc.9](https://img.shields.io/badge/AppVersion-1.3.0--rc.9-informational?style=flat-square)

OpenFGA authorization service for CAIPE relationship-based access control

## Bundled app policy

The parent chart's `global.caipeUiImage` selects one CAIPE build for the UI and
this initializer's `export-authorization-model` init container. The container
exports `/app/authorization` to a shared volume; the initializer publishes the
compiled model and its bundled module list. `global.imagePullSecrets` supplies
private-registry credentials. No app-specific model ConfigMap or module binding
is needed. The default core-only initializer is unchanged when that image is unset.

CAS resolves the immutable model matching its build exactly. It may start before
the post-install job, but protected requests fail closed until publication.
Changing/removing existing policy still requires a controlled migration; see the
[service integration reference](../../../../ui/examples/agentic-apps/service-only/README.md).

## Values

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| affinity | object | `{}` |  |
| checkQueryCache.enabled | bool | `false` |  |
| checkQueryCache.ttl | string | `"10s"` |  |
| datastore.engine | string | `"memory"` |  |
| datastore.maxOpenConns | string | `"50"` |  |
| datastore.uri | string | `""` |  |
| datastore.uriSecretRef.key | string | `"OPENFGA_DATASTORE_URI"` |  |
| datastore.uriSecretRef.name | string | `""` |  |
| extraVolumeMounts | list | `[]` |  |
| extraVolumes | list | `[]` |  |
| fullnameOverride | string | `""` |  |
| image.pullPolicy | string | `"IfNotPresent"` |  |
| image.repository | string | `"openfga/openfga"` |  |
| image.tag | string | `"v1.15.1"` |  |
| init.argocdHookDeletePolicy | string | `"BeforeHookCreation"` |  |
| init.backoffLimit | int | `6` |  |
| init.enabled | bool | `true` |  |
| init.authorizationModelId | string | `""` | Existing immutable model pin; initializer verifies it and only seeds tuples. |
| init.approvedModules | list | `[]` | Explicitly approved OpenFGA modules in an external compiled model. |
| init.existingModelConfigMap | string | `""` | Existing same-namespace ConfigMap containing authorization-model.json. Empty uses the bundled model; seed.py remains chart-owned. |
| init.helmHookDeletePolicy | string | `"before-hook-creation"` |  |
| init.image.pullPolicy | string | `"IfNotPresent"` |  |
| init.image.repository | string | `"python"` |  |
| init.image.tag | string | `"3.14-slim"` |  |
| init.platformClient.clientId | string | `"caipe-platform"` |  |
| init.platformClient.clientSecretRef.key | string | `"OIDC_CLIENT_SECRET"` |  |
| init.platformClient.clientSecretRef.name | string | `""` |  |
| init.platformClient.enabled | bool | `false` |  |
| init.platformClient.orgObject | string | `"organization:caipe"` |  |
| init.platformClient.tokenUrl | string | `""` |  |
| init.resources.limits.cpu | string | `"500m"` |  |
| init.resources.limits.memory | string | `"512Mi"` |  |
| init.resources.requests.cpu | string | `"100m"` |  |
| init.resources.requests.memory | string | `"128Mi"` |  |
| init.seedSub | string | `""` |  |
| init.seedTuples | list | `[]` |  |
| init.storeId | string | `""` | Existing store ID; set with authorizationModelId for a pinned rollout. |
| init.storeName | string | `"caipe-openfga"` |  |
| migrate.argocdHookDeletePolicy | string | `"BeforeHookCreation,HookSucceeded"` |  |
| migrate.backoffLimit | int | `6` |  |
| migrate.enabled | bool | `true` |  |
| migrate.helmHookDeletePolicy | string | `"before-hook-creation,hook-succeeded"` |  |
| migrate.resources.limits.cpu | string | `"500m"` |  |
| migrate.resources.limits.memory | string | `"512Mi"` |  |
| migrate.resources.requests.cpu | string | `"100m"` |  |
| migrate.resources.requests.memory | string | `"128Mi"` |  |
| nameOverride | string | `""` |  |
| nodeSelector | object | `{}` |  |
| playground.enabled | bool | `false` |  |
| podAnnotations | object | `{}` |  |
| podDisruptionBudget.annotations | object | `{}` |  |
| podDisruptionBudget.enabled | bool | `false` |  |
| podDisruptionBudget.maxUnavailable | int | `1` |  |
| podSecurityContext.fsGroup | int | `1001` |  |
| podSecurityContext.runAsGroup | int | `1001` |  |
| podSecurityContext.runAsNonRoot | bool | `true` |  |
| podSecurityContext.runAsUser | int | `1001` |  |
| replicaCount | int | `1` |  |
| resources.limits.cpu | string | `"500m"` |  |
| resources.limits.memory | string | `"512Mi"` |  |
| resources.requests.cpu | string | `"100m"` |  |
| resources.requests.memory | string | `"128Mi"` |  |
| securityContext.allowPrivilegeEscalation | bool | `false` |  |
| securityContext.capabilities.drop[0] | string | `"ALL"` |  |
| securityContext.runAsGroup | int | `1001` |  |
| securityContext.runAsNonRoot | bool | `true` |  |
| securityContext.runAsUser | int | `1001` |  |
| securityContext.seccompProfile.type | string | `"RuntimeDefault"` |  |
| service.grpcPort | int | `8081` |  |
| service.httpPort | int | `8080` |  |
| service.metricsPort | int | `2112` |  |
| service.playgroundPort | int | `3000` |  |
| service.type | string | `"ClusterIP"` |  |
| serviceAccount.annotations | object | `{}` |  |
| serviceAccount.automount | bool | `false` |  |
| serviceAccount.create | bool | `true` |  |
| serviceAccount.name | string | `""` |  |
| tolerations | list | `[]` |  |

----------------------------------------------
Autogenerated from chart metadata using [helm-docs v1.14.2](https://github.com/norwoodj/helm-docs/releases/v1.14.2)
