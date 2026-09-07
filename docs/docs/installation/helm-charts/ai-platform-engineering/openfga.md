---
id: openfga-chart
sidebar_label: openfga
---

:::caution Auto-generated
This page is auto-generated from the Helm chart source. Do not edit directly.
Regenerate with `make docs-helm-charts`.
:::

# openfga

OpenFGA authorization service for CAIPE relationship-based access control

| | |
|---|---|
| **Version** | `0.5.68` |
| **Type** | application |

## Quick Start

```bash
# Add and install the chart
helm install openfga oci://ghcr.io/cnoe-io/charts/openfga --version 0.5.68

# Upgrade an existing release
helm upgrade openfga oci://ghcr.io/cnoe-io/charts/openfga --version 0.5.68
```

## Customizing Values

Override default values using `--set` flags or a custom values file:

```bash
# Override individual values
helm install openfga oci://ghcr.io/cnoe-io/charts/openfga --version 0.5.68 \
  --set replicaCount=2

# Use a custom values file
helm install openfga oci://ghcr.io/cnoe-io/charts/openfga --version 0.5.68 \
  -f custom-values.yaml

# Show all configurable values
helm show values oci://ghcr.io/cnoe-io/charts/openfga --version 0.5.68
```

## Reading the Values Table

| Column | Meaning |
|--------|---------|
| **Key** | Dot-separated path into `values.yaml` (e.g. `image.repository`) |
| **Type** | Go/Helm data type (`string`, `int`, `bool`, `object`, `list`) |
| **Default** | Value used when not overridden |
| **Description** | What the parameter controls |

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
| init.helmHookDeletePolicy | string | `"before-hook-creation"` |  |
| init.image.pullPolicy | string | `"IfNotPresent"` |  |
| init.image.repository | string | `"python"` |  |
| init.image.tag | string | `"3.13-slim"` |  |
| init.seedSub | string | `""` |  |
| init.seedTuples | list | `[]` |  |
| init.storeName | string | `"caipe-openfga"` |  |
| migrate.argocdHookDeletePolicy | string | `"BeforeHookCreation,HookSucceeded"` |  |
| migrate.backoffLimit | int | `6` |  |
| migrate.enabled | bool | `true` |  |
| migrate.helmHookDeletePolicy | string | `"before-hook-creation,hook-succeeded"` |  |
| nameOverride | string | `""` |  |
| nodeSelector | object | `{}` |  |
| playground.enabled | bool | `false` |  |
| podAnnotations | object | `{}` |  |
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
| serviceAccount.create | bool | `true` |  |
| serviceAccount.name | string | `""` |  |
| tolerations | list | `[]` |  |
