{{/*
Expand the name of the chart.
*/}}
{{- define "agent.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Create a default fully qualified app name.
We truncate at 63 chars because some Kubernetes name fields are limited to this (by the DNS naming spec).
If release name contains chart name it will be used as a full name.
*/}}
{{- define "agent.fullname" -}}
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
Create chart name and version as used by the chart label.
*/}}
{{- define "agent.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Common labels
*/}}
{{- define "agent.labels" -}}
helm.sh/chart: {{ include "agent.chart" . }}
{{ include "agent.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{/*
Selector labels
*/}}
{{- define "agent.selectorLabels" -}}
app.kubernetes.io/name: {{ include "agent.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
Create the name of the service account to use
*/}}
{{- define "agent.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (include "agent.fullname" .) .Values.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.serviceAccount.name }}
{{- end }}
{{- end }}

{{/*
Determine if external secrets are enabled for llmSecrets - prioritize global
*/}}
{{- define "agent.llmSecrets.externalSecrets.enabled" -}}
    {{- $enabled := (default false .Values.llmSecrets.externalSecrets.enabled) -}}
    {{- with .Values.global -}}
        {{- with .externalSecrets -}}
            {{- if and (hasKey . "enabled") .enabled -}}
                {{- $enabled = true -}}
            {{- end -}}
        {{- end -}}
        {{- with .llmSecrets -}}
            {{- with .externalSecrets -}}
                {{- if hasKey . "enabled" -}}
                    {{- $enabled = .enabled -}}
                {{- end -}}
            {{- end -}}
        {{- end -}}
    {{- end -}}
    {{- $enabled -}}
{{- end }}

{{/*
Get llmSecrets.secretName with global fallback
*/}}
{{- define "agent.llmSecrets.secretName" -}}
    {{- $name := .Values.llmSecrets.secretName -}}
    {{- with .Values.global -}}
        {{- with .llmSecrets -}}
            {{- if hasKey . "secretName" -}}
                {{- $name = .secretName -}}
            {{- end -}}
        {{- end -}}
    {{- end -}}
    {{- $name -}}
{{- end -}}

{{/*
Get llmSecrets.create with global fallback
*/}}
{{- define "agent.llmSecrets.create" -}}
    {{- $create := .Values.llmSecrets.create -}}
    {{- with .Values.global -}}
        {{- with .llmSecrets -}}
            {{- if hasKey . "create" -}}
                {{- $create = .create -}}
            {{- end -}}
        {{- end -}}
    {{- end -}}
    {{- $create -}}
{{- end -}}

{{/*
Get llmSecrets.externalSecrets.name with fallback to secretName
*/}}
{{- define "agent.llmSecrets.externalSecrets.name" -}}
    {{- $name := "" -}}
    {{- if .Values.llmSecrets.externalSecrets.name -}}
        {{- $name = .Values.llmSecrets.externalSecrets.name -}}
    {{- end -}}
    {{- with .Values.global -}}
        {{- with .llmSecrets -}}
            {{- with .externalSecrets -}}
                {{- if hasKey . "name" -}}
                    {{- $name = .name -}}
                {{- end -}}
            {{- end -}}
        {{- end -}}
    {{- end -}}
    {{- if $name -}}
        {{- $name -}}
    {{- else -}}
        {{- include "agent.llmSecrets.secretName" . -}}
    {{- end -}}
{{- end -}}

{{/*
Get llmSecrets.externalSecrets.secretStoreRef with global fallback
*/}}
{{- define "agent.llmSecrets.externalSecrets.secretStoreRef" -}}
    {{- $ref := .Values.llmSecrets.externalSecrets.secretStoreRef -}}
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
    {{- $ref -}}
{{- end -}}

{{/*
Resolve the effective MCP secrets config.
mcpSecrets (new) is deep-merged on top of agentSecrets (deprecated) so either key works.
Keys set in mcpSecrets take precedence; unset keys fall back to agentSecrets values.
*/}}
{{- define "agent.effectiveSecrets" -}}
    {{- mergeOverwrite (deepCopy .Values.agentSecrets) (.Values.mcpSecrets | default dict) | toYaml -}}
{{- end -}}

{{/*
Get agentSecrets.create with global fallback
Always false when requiresSecret is false
*/}}
{{- define "agent.agentSecrets.create" -}}
    {{- $s := fromYaml (include "agent.effectiveSecrets" .) -}}
    {{- if not $s.requiresSecret -}}
        {{- false -}}
    {{- else -}}
        {{- $create := $s.create -}}
        {{- with .Values.global -}}
            {{- with .agentSecrets -}}
                {{- if hasKey . "create" -}}
                    {{- $create = .create -}}
                {{- end -}}
            {{- end -}}
        {{- end -}}
        {{- $create -}}
    {{- end -}}
{{- end -}}

{{/*
Determine if external secrets are enabled for agentSecrets - prioritize global
*/}}
{{- define "agent.agentSecrets.externalSecrets.enabled" -}}
    {{- $s := fromYaml (include "agent.effectiveSecrets" .) -}}
    {{- if not $s.requiresSecret -}}
        {{- false -}}
    {{- else -}}
        {{- $enabled := (default false $s.externalSecrets.enabled) -}}
        {{- with .Values.global -}}
            {{- with .externalSecrets -}}
                {{- if and (hasKey . "enabled") .enabled -}}
                    {{- $enabled = true -}}
                {{- end -}}
            {{- end -}}
            {{- with .agentSecrets -}}
                {{- with .externalSecrets -}}
                    {{- if hasKey . "enabled" -}}
                        {{- $enabled = .enabled -}}
                    {{- end -}}
                {{- end -}}
            {{- end -}}
        {{- end -}}
        {{- $enabled -}}
    {{- end -}}
{{- end }}

{{/*
Get agentSecrets.externalSecrets.secretStoreRef with global fallback
*/}}
{{- define "agent.agentSecrets.externalSecrets.secretStoreRef" -}}
    {{- $s := fromYaml (include "agent.effectiveSecrets" .) -}}
    {{- $ref := $s.externalSecrets.secretStoreRef -}}
    {{- with .Values.global -}}
        {{- with .externalSecrets -}}
            {{- if hasKey . "secretStoreRef" -}}
                {{- $ref = .secretStoreRef -}}
            {{- end -}}
        {{- end -}}
    {{- end -}}
    {{- toYaml $ref -}}
{{- end -}}

{{/*
Get agentSecrets.secretName - if empty assume no secret, if not append agent.name as prefix
*/}}
{{- define "agent.agentSecrets.secretName" -}}
    {{- $s := fromYaml (include "agent.effectiveSecrets" .) -}}
    {{- if $s.requiresSecret -}}
        {{- if $s.secretName -}}
            {{- $s.secretName -}}
        {{- else -}}
            {{- printf "%s-secret" (include "agent.name" .) -}}
        {{- end -}}
    {{- else -}}
        {{- "" -}}
    {{- end -}}
{{- end -}}

{{/*
Get agentSecrets.externalSecrets.name - if empty assume no secret, if not append agent.name as prefix
*/}}
{{- define "agent.agentSecrets.externalSecrets.name" -}}
    {{- $s := fromYaml (include "agent.effectiveSecrets" .) -}}
    {{- if $s.requiresSecret -}}
        {{- if $s.externalSecrets.name -}}
            {{- $s.externalSecrets.name -}}
        {{- else -}}
            {{- printf "%s-secret" (include "agent.name" .) -}}
        {{- end -}}
    {{- else -}}
        {{- "" -}}
    {{- end -}}
{{- end -}}

{{/*
Determine MCP mode
*/}}
{{- define "agent.createMcpHttpServer" -}}
    {{- if and (eq .Values.mcp.mode "http") (not .Values.mcp.useRemoteMcpServer) }}
        {{- true -}}
    {{- else -}}
        {{- false -}}
    {{- end -}}
{{- end -}}

{{- define "agent.appVersion" -}}
{{- .Values.global.image.tag | default .Chart.AppVersion -}}
{{- end -}}
