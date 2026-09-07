---
id: audit-service-chart
sidebar_label: audit-service
---

:::caution Auto-generated
This page is auto-generated from the Helm chart source. Do not edit directly.
Regenerate with `make docs-helm-charts`.
:::

# audit-service

Lightweight CAIPE audit log read/write service

| | |
|---|---|
| **Version** | `0.5.68` |
| **Type** | application |

## Quick Start

```bash
# Add and install the chart
helm install audit-service oci://ghcr.io/cnoe-io/charts/audit-service --version 0.5.68

# Upgrade an existing release
helm upgrade audit-service oci://ghcr.io/cnoe-io/charts/audit-service --version 0.5.68
```

## Customizing Values

Override default values using `--set` flags or a custom values file:

```bash
# Override individual values
helm install audit-service oci://ghcr.io/cnoe-io/charts/audit-service --version 0.5.68 \
  --set replicaCount=2

# Use a custom values file
helm install audit-service oci://ghcr.io/cnoe-io/charts/audit-service --version 0.5.68 \
  -f custom-values.yaml

# Show all configurable values
helm show values oci://ghcr.io/cnoe-io/charts/audit-service --version 0.5.68
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
| existingSecret | string | `""` |  |
| extraEnv | list | `[]` |  |
| extraEnvFrom | list | `[]` |  |
| fullnameOverride | string | `""` |  |
| image.pullPolicy | string | `"IfNotPresent"` |  |
| image.repository | string | `"ghcr.io/caipe-io/caipe-audit-service"` |  |
| image.tag | string | `""` |  |
| imagePullSecrets | list | `[]` |  |
| livenessProbe.failureThreshold | int | `3` |  |
| livenessProbe.httpGet.path | string | `"/healthz"` |  |
| livenessProbe.httpGet.port | string | `"http"` |  |
| livenessProbe.initialDelaySeconds | int | `0` |  |
| livenessProbe.periodSeconds | int | `20` |  |
| livenessProbe.timeoutSeconds | int | `5` |  |
| nameOverride | string | `""` |  |
| nodeSelector | object | `{}` |  |
| persistence.accessModes[0] | string | `"ReadWriteOnce"` |  |
| persistence.enabled | bool | `true` |  |
| persistence.size | string | `"10Gi"` |  |
| persistence.storageClass | string | `""` |  |
| podAnnotations | object | `{}` |  |
| podLabels | object | `{}` |  |
| podSecurityContext.fsGroup | int | `1001` |  |
| podSecurityContext.runAsGroup | int | `1001` |  |
| podSecurityContext.runAsNonRoot | bool | `true` |  |
| podSecurityContext.runAsUser | int | `1001` |  |
| queue.flushBatchSize | int | `500` |  |
| queue.flushIntervalSeconds | float | `1` |  |
| queue.maxSize | int | `10000` |  |
| read.defaultLimit | int | `1000` |  |
| read.maxDays | int | `31` |  |
| read.maxLimit | int | `10000` |  |
| readinessProbe.failureThreshold | int | `3` |  |
| readinessProbe.httpGet.path | string | `"/readyz"` |  |
| readinessProbe.httpGet.port | string | `"http"` |  |
| readinessProbe.initialDelaySeconds | int | `0` |  |
| readinessProbe.periodSeconds | int | `10` |  |
| readinessProbe.timeoutSeconds | int | `5` |  |
| replicaCount | int | `1` |  |
| resources.limits.cpu | string | `"500m"` |  |
| resources.limits.memory | string | `"1Gi"` |  |
| resources.requests.cpu | string | `"100m"` |  |
| resources.requests.memory | string | `"256Mi"` |  |
| revisionHistoryLimit | int | `3` |  |
| securityContext.allowPrivilegeEscalation | bool | `false` |  |
| securityContext.capabilities.drop[0] | string | `"ALL"` |  |
| securityContext.readOnlyRootFilesystem | bool | `false` |  |
| securityContext.runAsGroup | int | `1001` |  |
| securityContext.runAsNonRoot | bool | `true` |  |
| securityContext.runAsUser | int | `1001` |  |
| securityContext.seccompProfile.type | string | `"RuntimeDefault"` |  |
| service.port | int | `8010` |  |
| service.type | string | `"ClusterIP"` |  |
| serviceAccount.annotations | object | `{}` |  |
| serviceAccount.automount | bool | `true` |  |
| serviceAccount.create | bool | `true` |  |
| serviceAccount.name | string | `""` |  |
| startupProbe.failureThreshold | int | `18` |  |
| startupProbe.httpGet.path | string | `"/readyz"` |  |
| startupProbe.httpGet.port | string | `"http"` |  |
| startupProbe.initialDelaySeconds | int | `10` |  |
| startupProbe.periodSeconds | int | `10` |  |
| startupProbe.timeoutSeconds | int | `5` |  |
| storage.backend | string | `"auto"` |  |
| storage.local.gzip | bool | `true` |  |
| storage.local.path | string | `"/var/lib/caipe-audit-service"` |  |
| storage.local.retentionDays | int | `1` |  |
| storage.s3.bucket | string | `""` |  |
| storage.s3.endpointUrl | string | `""` |  |
| storage.s3.existingSecret.accessKeyIdKey | string | `"AWS_ACCESS_KEY_ID"` |  |
| storage.s3.existingSecret.name | string | `""` |  |
| storage.s3.existingSecret.secretAccessKeyKey | string | `"AWS_SECRET_ACCESS_KEY"` |  |
| storage.s3.existingSecret.sessionTokenKey | string | `"AWS_SESSION_TOKEN"` |  |
| storage.s3.prefix | string | `"audit"` |  |
| storage.s3.region | string | `""` |  |
| storage.s3.retentionDays | int | `0` |  |
| storage.s3.useAmbientCredentials | bool | `false` |  |
| tolerations | list | `[]` |  |
| verbosity | string | `"minimal"` |  |
| volumeMounts | list | `[]` |  |
| volumes | list | `[]` |  |
