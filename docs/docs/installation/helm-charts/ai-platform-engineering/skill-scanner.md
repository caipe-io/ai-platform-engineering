---
id: skill-scanner-chart
sidebar_label: skill-scanner
---

:::caution Auto-generated
This page is auto-generated from the Helm chart source. Do not edit directly.
Regenerate with `make docs-helm-charts`.
:::

# skill-scanner

Standalone deployment of cisco-ai-defense/skill-scanner running its built-in
REST API server. The CAIPE UI uploads zipped SKILL packages to /scan-upload
for safety analysis. The service is unauthenticated and MUST stay
cluster-internal (ClusterIP only — no Ingress).

| | |
|---|---|
| **Version** | `0.5.68` |
| **Type** | application |

## Quick Start

```bash
# Add and install the chart
helm install skill-scanner oci://ghcr.io/cnoe-io/charts/skill-scanner --version 0.5.68

# Upgrade an existing release
helm upgrade skill-scanner oci://ghcr.io/cnoe-io/charts/skill-scanner --version 0.5.68
```

## Customizing Values

Override default values using `--set` flags or a custom values file:

```bash
# Override individual values
helm install skill-scanner oci://ghcr.io/cnoe-io/charts/skill-scanner --version 0.5.68 \
  --set replicaCount=2

# Use a custom values file
helm install skill-scanner oci://ghcr.io/cnoe-io/charts/skill-scanner --version 0.5.68 \
  -f custom-values.yaml

# Show all configurable values
helm show values oci://ghcr.io/cnoe-io/charts/skill-scanner --version 0.5.68
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
| affinity | object | `{}` | Pod affinity rules |
| fullnameOverride | string | `""` | Override the full release name |
| image.pullPolicy | string | `"IfNotPresent"` | Image pull policy |
| image.repository | string | `"ghcr.io/caipe-io/skill-scanner"` | Container image repository. Build via build/Dockerfile.skill-scanner and push to your registry; override in the parent values.yaml. |
| image.tag | string | `""` | Image tag. Defaults to the parent chart's appVersion. |
| imagePullSecrets | list | `[]` | Image pull secrets for private registries |
| livenessProbe | object | `{"failureThreshold":3,"httpGet":{"path":"/health","port":"http"},"initialDelaySeconds":0,"periodSeconds":20,"timeoutSeconds":3}` | Liveness probe — hits the FastAPI /health endpoint. |
| llm | object | `{"apiKey":{"secretKey":"SKILL_SCANNER_LLM_API_KEY","secretName":""},"enabled":false,"model":""}` | Optional environment for the LLM-backed analyzer. Leave the secret unset to run static-only scans (still valuable for catching obvious unsafe patterns). Bind to an existing Secret + key when LLM scanning is desired. |
| llm.apiKey.secretKey | string | `"SKILL_SCANNER_LLM_API_KEY"` | Key inside the Secret |
| llm.apiKey.secretName | string | `""` | Existing Secret holding the LLM API key |
| llm.enabled | bool | `false` | Set to true to inject SKILL_SCANNER_LLM_API_KEY from the secret below |
| llm.model | string | `""` | Model id passed via SKILL_SCANNER_LLM_MODEL (e.g. anthropic/claude-sonnet-4-20250514) |
| nameOverride | string | `""` | Override the chart name |
| nodeSelector | object | `{}` | Node selector labels |
| podAnnotations | object | `{}` | Extra annotations added to the pod |
| podLabels | object | `{}` | Extra labels added to the pod |
| podSecurityContext.fsGroup | int | `1001` | fsGroup matches runtime UID to keep emptyDir / tmp permissions sane |
| readinessProbe | object | `{"failureThreshold":3,"httpGet":{"path":"/health","port":"http"},"initialDelaySeconds":0,"periodSeconds":10,"timeoutSeconds":3}` | Readiness probe — same /health endpoint. |
| replicaCount | int | `1` | Number of replicas. Scanner is stateless; scale horizontally if you expect concurrent scans from many UI users. |
| resources.limits.cpu | string | `"1"` | CPU limit — bursts during multi-analyzer runs. |
| resources.limits.memory | string | `"1Gi"` | Memory limit — leaves headroom for unzipped skill trees up to 200MB. |
| resources.requests.cpu | string | `"100m"` | CPU request — static analyzers are mostly I/O-light Python. |
| resources.requests.memory | string | `"256Mi"` | Memory request — covers Python interpreter + bytecode analyzer state. |
| revisionHistoryLimit | int | `3` | Number of old ReplicaSets to retain for rollback |
| securityContext.allowPrivilegeEscalation | bool | `false` | Block privilege escalation |
| securityContext.capabilities.drop[0] | string | `"ALL"` |  |
| securityContext.readOnlyRootFilesystem | bool | `true` | Read-only root FS (scanner unzips skills under /tmp) |
| securityContext.runAsGroup | int | `1001` | GID to run as |
| securityContext.runAsNonRoot | bool | `true` | Run as non-root user (matches Dockerfile.skill-scanner) |
| securityContext.runAsUser | int | `1001` | UID to run as |
| service.port | int | `8000` |  |
| service.type | string | `"ClusterIP"` | ClusterIP only — never expose this Service externally. The scanner API is unauthenticated and accepts arbitrary ZIP uploads. |
| serviceAccount.annotations | object | `{}` | Annotations to add to the service account |
| serviceAccount.automount | bool | `false` | Automount the service account API token (scanner doesn't need K8s API) |
| serviceAccount.create | bool | `true` | Create a service account |
| serviceAccount.name | string | `""` | Override the service account name |
| startupProbe | object | `{"failureThreshold":18,"httpGet":{"path":"/health","port":"http"},"initialDelaySeconds":10,"periodSeconds":10,"timeoutSeconds":3}` | Startup probe — gates liveness/readiness until the process is up. |
| tolerations | list | `[]` | Pod tolerations |
| volumeMounts | list | `[]` | Extra volume mounts |
| volumes | list | `[]` | Extra volumes (e.g. larger emptyDir for /tmp on busy clusters). An emptyDir is mounted at /tmp by default — the scanner extracts ZIPs there. |
| vpa.controlledResources[0] | string | `"cpu"` |  |
| vpa.controlledResources[1] | string | `"memory"` |  |
| vpa.controlledValues | string | `"RequestsAndLimits"` |  |
| vpa.enabled | bool | `false` |  |
| vpa.maxAllowed | object | `{}` |  |
| vpa.minAllowed.cpu | string | `"50m"` |  |
| vpa.minAllowed.memory | string | `"128Mi"` |  |
| vpa.updateMode | string | `"InPlaceOrRecreate"` |  |
