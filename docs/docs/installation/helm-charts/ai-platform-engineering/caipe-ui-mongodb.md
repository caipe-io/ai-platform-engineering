---
id: caipe-ui-mongodb-chart
sidebar_label: caipe-ui-mongodb
---

:::caution Auto-generated
This page is auto-generated from the Helm chart source. Do not edit directly.
Regenerate with `make docs-helm-charts`.
:::

# caipe-ui-mongodb

MongoDB database for CAIPE UI persistence

| | |
|---|---|
| **Version** | `0.5.68` |
| **Type** | application |

## Quick Start

```bash
# Add and install the chart
helm install caipe-ui-mongodb oci://ghcr.io/cnoe-io/charts/caipe-ui-mongodb --version 0.5.68

# Upgrade an existing release
helm upgrade caipe-ui-mongodb oci://ghcr.io/cnoe-io/charts/caipe-ui-mongodb --version 0.5.68
```

## Customizing Values

Override default values using `--set` flags or a custom values file:

```bash
# Override individual values
helm install caipe-ui-mongodb oci://ghcr.io/cnoe-io/charts/caipe-ui-mongodb --version 0.5.68 \
  --set replicaCount=2

# Use a custom values file
helm install caipe-ui-mongodb oci://ghcr.io/cnoe-io/charts/caipe-ui-mongodb --version 0.5.68 \
  -f custom-values.yaml

# Show all configurable values
helm show values oci://ghcr.io/cnoe-io/charts/caipe-ui-mongodb --version 0.5.68
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
| auth.database | string | `"caipe"` |  |
| auth.rootPassword | string | `"changeme"` |  |
| auth.rootUsername | string | `"admin"` |  |
| exports.database | string | `"caipe"` |  |
| exports.host | string | `"mongodb"` |  |
| exports.port | int | `27017` |  |
| externalSecrets.apiVersion | string | `"v1beta1"` |  |
| externalSecrets.data | list | `[]` |  |
| externalSecrets.enabled | bool | `false` |  |
| externalSecrets.secretStoreRef.kind | string | `"ClusterSecretStore"` |  |
| externalSecrets.secretStoreRef.name | string | `"vault"` |  |
| fullnameOverride | string | `""` |  |
| image.pullPolicy | string | `"IfNotPresent"` |  |
| image.repository | string | `"mongo"` |  |
| image.tag | string | `"7.0"` |  |
| imagePullSecrets | list | `[]` |  |
| livenessProbe.exec.command[0] | string | `"mongosh"` |  |
| livenessProbe.exec.command[1] | string | `"--eval"` |  |
| livenessProbe.exec.command[2] | string | `"db.adminCommand('ping')"` |  |
| livenessProbe.failureThreshold | int | `3` |  |
| livenessProbe.initialDelaySeconds | int | `30` |  |
| livenessProbe.periodSeconds | int | `10` |  |
| livenessProbe.timeoutSeconds | int | `5` |  |
| nameOverride | string | `""` |  |
| nodeSelector | object | `{}` |  |
| persistence.accessModes[0] | string | `"ReadWriteOnce"` |  |
| persistence.enabled | bool | `true` |  |
| persistence.size | string | `"10Gi"` |  |
| persistence.storageClass | string | `""` |  |
| podAnnotations | object | `{}` |  |
| podLabels | object | `{}` |  |
| podSecurityContext.fsGroup | int | `999` |  |
| podSecurityContext.runAsNonRoot | bool | `true` |  |
| readinessProbe.exec.command[0] | string | `"mongosh"` |  |
| readinessProbe.exec.command[1] | string | `"--eval"` |  |
| readinessProbe.exec.command[2] | string | `"db.adminCommand('ping')"` |  |
| readinessProbe.failureThreshold | int | `3` |  |
| readinessProbe.initialDelaySeconds | int | `5` |  |
| readinessProbe.periodSeconds | int | `5` |  |
| readinessProbe.timeoutSeconds | int | `3` |  |
| replicaCount | int | `1` |  |
| resources | object | `{}` |  |
| revisionHistoryLimit | int | `3` |  |
| securityContext.allowPrivilegeEscalation | bool | `false` |  |
| securityContext.capabilities.drop[0] | string | `"ALL"` |  |
| securityContext.runAsNonRoot | bool | `true` |  |
| securityContext.runAsUser | int | `999` |  |
| securityContext.seccompProfile.type | string | `"RuntimeDefault"` |  |
| service.port | int | `27017` |  |
| service.type | string | `"ClusterIP"` |  |
| serviceAccount.annotations | object | `{}` |  |
| serviceAccount.automount | bool | `true` |  |
| serviceAccount.create | bool | `true` |  |
| serviceAccount.name | string | `""` |  |
| strictPasswords | bool | `false` |  |
| tolerations | list | `[]` |  |
| vpa.controlledResources[0] | string | `"cpu"` |  |
| vpa.controlledResources[1] | string | `"memory"` |  |
| vpa.controlledValues | string | `"RequestsAndLimits"` |  |
| vpa.enabled | bool | `false` |  |
| vpa.maxAllowed | object | `{}` |  |
| vpa.minAllowed.cpu | string | `"50m"` |  |
| vpa.minAllowed.memory | string | `"128Mi"` |  |
| vpa.updateMode | string | `"InPlaceOrRecreate"` |  |
