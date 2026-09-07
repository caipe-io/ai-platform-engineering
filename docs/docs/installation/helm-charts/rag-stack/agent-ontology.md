---
id: agent-ontology-chart
sidebar_label: agent-ontology
---

:::caution Auto-generated
This page is auto-generated from the Helm chart source. Do not edit directly.
Regenerate with `make docs-helm-charts`.
:::

# agent-ontology

A Helm chart for Kubernetes

| | |
|---|---|
| **Version** | `0.5.68` |
| **Type** | application |

## Quick Start

```bash
# Add and install the chart
helm install agent-ontology oci://ghcr.io/cnoe-io/charts/agent-ontology --version 0.5.68

# Upgrade an existing release
helm upgrade agent-ontology oci://ghcr.io/cnoe-io/charts/agent-ontology --version 0.5.68
```

## Customizing Values

Override default values using `--set` flags or a custom values file:

```bash
# Override individual values
helm install agent-ontology oci://ghcr.io/cnoe-io/charts/agent-ontology --version 0.5.68 \
  --set replicaCount=2

# Use a custom values file
helm install agent-ontology oci://ghcr.io/cnoe-io/charts/agent-ontology --version 0.5.68 \
  -f custom-values.yaml

# Show all configurable values
helm show values oci://ghcr.io/cnoe-io/charts/agent-ontology --version 0.5.68
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
| agentRecursionLimit | int | `100` |  |
| autoscaling.enabled | bool | `false` |  |
| autoscaling.maxReplicas | int | `100` |  |
| autoscaling.minReplicas | int | `1` |  |
| autoscaling.targetCPUUtilizationPercentage | int | `80` |  |
| countChangeThresholdRatio | float | `0.1` |  |
| debugAgent | bool | `false` |  |
| env | object | `{}` |  |
| fullnameOverride | string | `"agent-ontology"` |  |
| image.pullPolicy | string | `"IfNotPresent"` |  |
| image.repository | string | `"ghcr.io/caipe-io/caipe-rag-agent-ontology"` |  |
| image.tag | string | `""` |  |
| imagePullSecrets | list | `[]` |  |
| ingress.annotations | object | `{}` |  |
| ingress.className | string | `"nginx"` |  |
| ingress.enabled | bool | `false` |  |
| ingress.hosts[0].host | string | `"agent-ontology.local"` |  |
| ingress.hosts[0].paths[0].path | string | `"/"` |  |
| ingress.hosts[0].paths[0].pathType | string | `"Prefix"` |  |
| ingress.tls | list | `[]` |  |
| livenessProbe.failureThreshold | int | `3` |  |
| livenessProbe.httpGet.path | string | `"/health"` |  |
| livenessProbe.httpGet.port | string | `"http"` |  |
| livenessProbe.periodSeconds | int | `10` |  |
| livenessProbe.timeoutSeconds | int | `5` |  |
| llmSecrets.create | bool | `false` |  |
| llmSecrets.data | object | `{}` |  |
| llmSecrets.externalSecrets.data | list | `[]` |  |
| llmSecrets.externalSecrets.enabled | bool | `false` |  |
| llmSecrets.externalSecrets.secretStoreRef.kind | string | `"ClusterSecretStore"` |  |
| llmSecrets.externalSecrets.secretStoreRef.name | string | `""` |  |
| llmSecrets.secretName | string | `"llm-secret"` |  |
| logLevel | string | `"INFO"` |  |
| maxConcurrentEvaluation | int | `10` |  |
| maxLlmTokens | int | `100000` |  |
| minCountForEval | int | `3` |  |
| nameOverride | string | `""` |  |
| nodeSelector | object | `{}` |  |
| podAnnotations | object | `{}` |  |
| podLabels | object | `{}` |  |
| podSecurityContext.runAsNonRoot | bool | `true` |  |
| readinessProbe.failureThreshold | int | `3` |  |
| readinessProbe.httpGet.path | string | `"/v1/graph/ontology/agent/status"` |  |
| readinessProbe.httpGet.port | string | `"http"` |  |
| readinessProbe.periodSeconds | int | `5` |  |
| readinessProbe.timeoutSeconds | int | `3` |  |
| replicaCount | int | `1` |  |
| resources | object | `{}` |  |
| revisionHistoryLimit | int | `3` |  |
| secrets.data | object | `{}` |  |
| secrets.secretName | string | `"llm-secret"` |  |
| securityContext.allowPrivilegeEscalation | bool | `false` |  |
| securityContext.capabilities.drop[0] | string | `"ALL"` |  |
| securityContext.readOnlyRootFilesystem | bool | `false` |  |
| securityContext.runAsNonRoot | bool | `true` |  |
| securityContext.runAsUser | int | `1001` |  |
| securityContext.seccompProfile.type | string | `"RuntimeDefault"` |  |
| serverPort | int | `8098` |  |
| service.port | int | `8098` |  |
| service.type | string | `"ClusterIP"` |  |
| serviceAccount.annotations | object | `{}` |  |
| serviceAccount.automount | bool | `true` |  |
| serviceAccount.create | bool | `true` |  |
| serviceAccount.name | string | `""` |  |
| startupProbe.failureThreshold | int | `30` |  |
| startupProbe.httpGet.path | string | `"/health"` |  |
| startupProbe.httpGet.port | string | `"http"` |  |
| startupProbe.initialDelaySeconds | int | `10` |  |
| startupProbe.periodSeconds | int | `10` |  |
| startupProbe.timeoutSeconds | int | `5` |  |
| syncInterval | int | `259200` |  |
| tolerations | list | `[]` |  |
| volumeMounts | list | `[]` |  |
| volumes | list | `[]` |  |
| vpa.controlledResources[0] | string | `"cpu"` |  |
| vpa.controlledResources[1] | string | `"memory"` |  |
| vpa.controlledValues | string | `"RequestsAndLimits"` |  |
| vpa.enabled | bool | `false` |  |
| vpa.maxAllowed | object | `{}` |  |
| vpa.minAllowed.cpu | string | `"50m"` |  |
| vpa.minAllowed.memory | string | `"128Mi"` |  |
| vpa.updateMode | string | `"InPlaceOrRecreate"` |  |
