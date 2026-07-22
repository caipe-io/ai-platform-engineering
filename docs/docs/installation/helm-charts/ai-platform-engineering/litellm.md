---
id: litellm-chart
sidebar_label: litellm
---

:::caution Auto-generated
This page is auto-generated from the Helm chart source. Do not edit directly.
Regenerate with `make docs-helm-charts`.
:::

# litellm

Stateless LiteLLM proxy - the default central LLM routing layer for CAIPE agents (default-off; no persisted storage)

| | |
|---|---|
| **Version** | `0.5.55` |
| **Type** | application |

## Quick Start

```bash
# Add and install the chart
helm install litellm oci://ghcr.io/cnoe-io/charts/litellm --version 0.5.55

# Upgrade an existing release
helm upgrade litellm oci://ghcr.io/cnoe-io/charts/litellm --version 0.5.55
```

## Customizing Values

Override default values using `--set` flags or a custom values file:

```bash
# Override individual values
helm install litellm oci://ghcr.io/cnoe-io/charts/litellm --version 0.5.55 \
  --set replicaCount=2

# Use a custom values file
helm install litellm oci://ghcr.io/cnoe-io/charts/litellm --version 0.5.55 \
  -f custom-values.yaml

# Show all configurable values
helm show values oci://ghcr.io/cnoe-io/charts/litellm --version 0.5.55
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
| extraEnv | list | `[]` |  |
| extraEnvFrom | list | `[]` |  |
| fullnameOverride | string | `""` |  |
| generalSettings | object | `{}` |  |
| image.pullPolicy | string | `"IfNotPresent"` |  |
| image.repository | string | `"ghcr.io/berriai/litellm"` |  |
| image.tag | string | `"v1.92.0"` |  |
| litellmSettings.num_retries | int | `0` |  |
| masterKeySecret.key | string | `"OPENAI_API_KEY"` |  |
| masterKeySecret.name | string | `""` |  |
| modelList | list | `[]` |  |
| nameOverride | string | `""` |  |
| networkPolicy.enabled | bool | `true` |  |
| nodeSelector | object | `{}` |  |
| podAnnotations | object | `{}` |  |
| replicaCount | int | `1` |  |
| resources | object | `{}` |  |
| service.port | int | `4000` |  |
| service.type | string | `"ClusterIP"` |  |
| serviceAccount.annotations | object | `{}` |  |
| serviceAccount.create | bool | `true` |  |
| serviceAccount.name | string | `""` |  |
| tolerations | list | `[]` |  |
| upstreamSecret.create | bool | `false` |  |
| upstreamSecret.data | object | `{}` |  |
| upstreamSecret.name | string | `""` |  |

