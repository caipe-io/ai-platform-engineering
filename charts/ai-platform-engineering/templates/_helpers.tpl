{{/*
Expand the name of the chart.
*/}}
{{- define "ai-platform-engineering.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Create a default fully qualified app name.
*/}}
{{- define "ai-platform-engineering.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{/*
Common labels
*/}}
{{- define "ai-platform-engineering.labels" -}}
helm.sh/chart: {{ include "ai-platform-engineering.chart" . }}
{{ include "ai-platform-engineering.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{/*
Selector labels
*/}}
{{- define "ai-platform-engineering.selectorLabels" -}}
app.kubernetes.io/name: {{ include "ai-platform-engineering.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
Create chart name and version as used by the chart label.
*/}}
{{- define "ai-platform-engineering.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "ai-platform-engineering.externalSecrets.enabled" -}}
    {{- if and (hasKey .Values "global") (hasKey .Values.global "externalSecrets") (hasKey .Values.global.externalSecrets "enabled") }}
        {{- .Values.global.externalSecrets.enabled }}
    {{- else if and (hasKey .Values "global") (hasKey .Values.global "llmSecrets") (hasKey .Values.global.llmSecrets "externalSecrets") (hasKey .Values.global.llmSecrets.externalSecrets "enabled") }}
        {{- .Values.global.llmSecrets.externalSecrets.enabled }}
    {{- else }}
        {{- false }}
    {{- end }}
{{- end }}

{{/*
Get externalSecrets API version with fallback to v1 (most clusters have v1 installed)
*/}}
{{- define "ai-platform-engineering.externalSecrets.apiVersion" -}}
    {{- if and (hasKey .Values "global") (hasKey .Values.global "externalSecrets") (hasKey .Values.global.externalSecrets "apiVersion") }}
        {{- .Values.global.externalSecrets.apiVersion }}
    {{- else if and (hasKey .Values "global") (hasKey .Values.global "llmSecrets") (hasKey .Values.global.llmSecrets "externalSecrets") (hasKey .Values.global.llmSecrets.externalSecrets "apiVersion") }}
        {{- .Values.global.llmSecrets.externalSecrets.apiVersion }}
    {{- else }}
        {{- "v1" }}
    {{- end }}
{{- end }}

{{/*
Get llmSecrets.externalSecrets.secretStoreRef with global fallback
*/}}
{{- define "ai-platform-engineering.externalSecrets.secretStoreRef" -}}
    {{- $ref := dict -}}
    {{- with .Values.global -}}
        {{- with .externalSecrets -}}
            {{- if hasKey . "secretStoreRef" -}}
                {{- $ref = .secretStoreRef -}}
            {{- end -}}
        {{- end -}}
        {{- with .llmSecrets -}}
            {{- with .externalSecrets -}}
                {{- if hasKey . "secretStoreRef" -}}
                    {{- $ref = .secretStoreRef -}}
                {{- end -}}
            {{- end -}}
        {{- end -}}
    {{- end -}}
    {{- toYaml $ref -}}
{{- end -}}

{{- define "ai-platform-engineering.llmSecrets.secretName" -}}
    {{- if and (hasKey .Values "global") (hasKey .Values.global "llmSecrets") (hasKey .Values.global.llmSecrets "secretName") }}
        {{- .Values.global.llmSecrets.secretName }}
    {{- else }}
        {{- "llm-secret" }}
    {{- end }}
{{- end }}

{{- define "ai-platform-engineering.llmSecrets.externalSecrets.name" -}}
    {{- if and (hasKey .Values "global") (hasKey .Values.global "llmSecrets") (hasKey .Values.global.llmSecrets "externalSecrets") (hasKey .Values.global.llmSecrets.externalSecrets "name") }}
        {{- .Values.global.llmSecrets.externalSecrets.name }}
    {{- else if include "ai-platform-engineering.llmSecrets.secretName" .  }}
        {{- include "ai-platform-engineering.llmSecrets.secretName" . }}
    {{- else }}
        {{- "llm-secret" }}
    {{- end }}
{{- end }}

{{/*
Returns the enabledSubAgents dict as YAML.
Reads from global.enabledSubAgents, populated by Chart.yaml import-values
(e.g. global.enabledSubAgents.backstage.enabled: true).
*/}}
{{- define "ai-platform-engineering.enabledSubAgents" -}}
{{- .Values.global.enabledSubAgents | default dict | toYaml -}}
{{- end -}}

{{- define "ai-platform-engineering.appVersion" -}}
{{- .Values.global.image.tag | default .Chart.AppVersion -}}
{{- end -}}

{{/*
Return true when an MCP target should receive the AgentGateway provider-token
rewrite. Operators may set providerTokenAuth directly, or declare the same
header-targeted credential_sources consumed by Dynamic Agents.
assisted-by Codex Codex-sonnet-4-6
*/}}
{{- define "ai-platform-engineering.agentgatewayProviderTokenAuth" -}}
{{- $values := . | default dict -}}
{{- $enabled := false -}}
{{- if $values.providerTokenAuth -}}
{{- $enabled = true -}}
{{- else -}}
{{- $sources := ($values.credential_sources | default $values.credentialSources) | default list -}}
{{- range $source := $sources -}}
{{- $kind := $source.kind | default "" -}}
{{- if and (eq ($source.target | default "") "header") (or (eq $kind "provider_connection") (eq $kind "caller_token")) -}}
{{- $enabled = true -}}
{{- end -}}
{{- end -}}
{{- end -}}
{{- $enabled -}}
{{- end -}}

{{/*
Normalized list of AgentGateway MCP targets, as YAML.

Single source of truth for both the Gateway API custom resources
(templates/agentgateway-mcp.yaml) and the CRD-free standalone static config
(templates/agentgateway-static-config.yaml). Each entry is a dict:

  id:          MCP server id / route segment (e.g. "argocd", "knowledge-base")
  pathPrefix:  HTTP path prefix served by the gateway (e.g. "/mcp/argocd")
  host:        in-cluster MCP service DNS (host only, no scheme/path)
  port:        MCP service port
  protocol:    AgentGateway target protocol (StreamableHTTP | SSE)
  backendAuthKey (optional): env-var reference for upstream backend auth
  providerTokenAuth (optional): when true, rewrite X-CAIPE-Provider-Token into
                                the upstream Authorization: Bearer header

Sources, in order: enabled subagents with mcp.agentgateway.enabled,
global.agentgateway.knowledgeBaseTarget, global.agentgateway.extraMcpTargets.
*/}}
{{- define "ai-platform-engineering.agentgatewayMcpTargets" -}}
{{- $root := . -}}
{{- $ns := $root.Release.Namespace -}}
{{- $agw := (($root.Values.global).agentgateway) | default dict -}}
{{- $targets := list -}}
{{- range $name, $enabled := (include "ai-platform-engineering.enabledSubAgents" $root | fromYaml) -}}
{{- if $enabled -}}
{{- $agentValues := index $root.Values (printf "mcp-%s" $name) | default dict -}}
{{- $mcp := $agentValues.mcp | default dict -}}
{{- $sub := $mcp.agentgateway | default dict -}}
{{- if $sub.enabled -}}
{{- $targetId := $sub.id | default $name -}}
{{- $pathPrefix := $sub.pathPrefix | default (printf "/mcp/%s" $targetId) -}}
{{- $entry := dict "id" $targetId "pathPrefix" $pathPrefix "host" (printf "%s-mcp-%s-mcp.%s.svc.cluster.local" $root.Release.Name $name $ns) "port" ($mcp.port | default 8000) "protocol" ($sub.protocol | default "StreamableHTTP") -}}
{{- if eq (include "ai-platform-engineering.agentgatewayProviderTokenAuth" $sub) "true" -}}
{{- $_ := set $entry "providerTokenAuth" true -}}
{{- end -}}
{{- $targets = append $targets $entry -}}
{{- end -}}
{{- end -}}
{{- end -}}
{{- $schedulerEnabled := dig "scheduler" "enabled" false ($root.Values.global | default dict) -}}
{{- $schedulerMcp := $root.Values.schedulerMcp | default dict -}}
{{- if and $schedulerEnabled ($schedulerMcp.enabled | default false) -}}
{{- $schedulerService := $schedulerMcp.service | default dict -}}
{{- $targets = append $targets (dict "id" "scheduler" "pathPrefix" "/mcp/scheduler" "host" (printf "%s.%s.svc.cluster.local" ($schedulerMcp.nameOverride | default "mcp-scheduler") $ns) "port" ($schedulerService.port | default 8000) "protocol" "StreamableHTTP") -}}
{{- end -}}
{{- $kb := $agw.knowledgeBaseTarget | default dict -}}
{{- if or (not (hasKey $kb "enabled")) $kb.enabled -}}
{{- $kbHost := required "global.agentgateway.knowledgeBaseTarget.host is required" $kb.host -}}
{{- $kbPort := required "global.agentgateway.knowledgeBaseTarget.port is required" $kb.port -}}
{{- /* The RAG server enforces its own Keycloak/OIDC auth on /mcp. Dynamic Agents
forwards the caller's user JWT (per-user RAG group RBAC) or a caipe-platform
service token (non-user contexts) on X-CAIPE-Provider-Token, and a route-level
transformation rewrites it into Authorization: Bearer. */ -}}
{{- $targets = append $targets (dict "id" "knowledge-base" "pathPrefix" ($kb.pathPrefix | default "/mcp/knowledge-base") "host" (tpl $kbHost $root) "port" $kbPort "protocol" ($kb.protocol | default "StreamableHTTP") "providerTokenAuth" (eq (include "ai-platform-engineering.agentgatewayProviderTokenAuth" $kb) "true")) -}}
{{- end -}}
{{- /* GitHub MCP server — official GitHub MCP server container (mcp-servers profile).
Routes /mcp/github-mcp-server to the in-cluster Deployment rendered by
github-mcp-server.yaml when global.agentgateway.githubMcpServer.enabled is true.
assisted-by Codex Codex-sonnet-4-6 */ -}}
{{- $ghMcp := $agw.githubMcpServer | default dict -}}
{{- if and (hasKey $ghMcp "enabled") $ghMcp.enabled -}}
{{- $_ := required "global.agentgateway.githubMcpServer.existingSecret.name is required when githubMcpServer.enabled=true" (($ghMcp.existingSecret | default dict).name) -}}
{{- $ghPort := $ghMcp.port | default 8082 -}}
{{- $ghPath := $ghMcp.pathPrefix | default "/mcp/github-mcp-server" -}}
{{- $ghHost := printf "%s-github-mcp-server.%s.svc.cluster.local" $root.Release.Name $ns -}}
{{- $targets = append $targets (dict "id" "github-mcp-server" "pathPrefix" $ghPath "host" $ghHost "port" $ghPort "protocol" "StreamableHTTP" "backendAuthKey" "$GITHUB_PERSONAL_ACCESS_TOKEN") -}}
{{- end -}}
{{- range $target := ($agw.extraMcpTargets | default list) -}}
{{- if or (not (hasKey $target "enabled")) $target.enabled -}}
{{- $id := required "global.agentgateway.extraMcpTargets[].id is required" $target.id -}}
{{- $safeId := regexReplaceAll "[^a-z0-9-]" (lower $id) "-" | trunc 45 | trimSuffix "-" -}}
{{- $host := required (printf "global.agentgateway.extraMcpTargets[%s].host is required" $id) $target.host -}}
{{- $port := required (printf "global.agentgateway.extraMcpTargets[%s].port is required" $id) $target.port -}}
{{- $targets = append $targets (dict "id" $safeId "pathPrefix" ($target.pathPrefix | default (printf "/mcp/%s" $id)) "host" (tpl $host $root) "port" $port "protocol" ($target.protocol | default "StreamableHTTP") "providerTokenAuth" (eq (include "ai-platform-engineering.agentgatewayProviderTokenAuth" $target) "true")) -}}
{{- end -}}
{{- end -}}
{{- $targets | toYaml -}}
{{- end -}}

{{/*
LiteLLM MCP standalone server helpers.
*/}}
{{- define "ai-platform-engineering.litellmMcp.name" -}}
{{- $values := .Values.litellmMcp | default dict -}}
{{- default "litellm-mcp" $values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "ai-platform-engineering.litellmMcp.fullname" -}}
{{- $values := .Values.litellmMcp | default dict -}}
{{- if $values.fullnameOverride -}}
{{- $values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $name := default "litellm-mcp" $values.nameOverride -}}
{{- if contains $name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{- define "ai-platform-engineering.litellmMcp.selectorLabels" -}}
app.kubernetes.io/name: {{ include "ai-platform-engineering.litellmMcp.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/component: mcp
{{- end -}}

{{- define "ai-platform-engineering.litellmMcp.labels" -}}
helm.sh/chart: {{ include "ai-platform-engineering.chart" . }}
{{ include "ai-platform-engineering.litellmMcp.selectorLabels" . }}
app.kubernetes.io/part-of: {{ include "ai-platform-engineering.name" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{- define "ai-platform-engineering.litellmMcp.secretName" -}}
{{- $values := .Values.litellmMcp | default dict -}}
{{- if $values.existingSecret -}}
{{- $values.existingSecret -}}
{{- else -}}
{{- $secret := $values.secret | default dict -}}
{{- default (include "ai-platform-engineering.litellmMcp.fullname" .) $secret.name -}}
{{- end -}}
{{- end -}}
