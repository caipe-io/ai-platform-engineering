{{/*
Expand the name of the chart.
*/}}
{{- define "autonomous-agents.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Create a default fully qualified app name.
We truncate at 63 chars because some Kubernetes name fields are limited to this (by the DNS naming spec).
If release name contains chart name it will be used as a full name.
*/}}
{{- define "autonomous-agents.fullname" -}}
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
{{- define "autonomous-agents.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Common labels
*/}}
{{- define "autonomous-agents.labels" -}}
helm.sh/chart: {{ include "autonomous-agents.chart" . }}
{{ include "autonomous-agents.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{/*
Selector labels
*/}}
{{- define "autonomous-agents.selectorLabels" -}}
app.kubernetes.io/name: {{ include "autonomous-agents.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
Create the name of the service account to use
*/}}
{{- define "autonomous-agents.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (include "autonomous-agents.fullname" .) .Values.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.serviceAccount.name }}
{{- end }}
{{- end }}

{{- define "autonomous-agents.appVersion" -}}
{{- dig "image" "tag" "" (default dict .Values.global) | default .Chart.AppVersion -}}
{{- end -}}

{{/*
Default in-release endpoints. Keep values.yaml static; operators can still
override these by setting config.SUPERVISOR_URL / config.DYNAMIC_AGENTS_URL.
*/}}
{{- define "autonomous-agents.supervisorUrl" -}}
{{- .Values.config.SUPERVISOR_URL | default (printf "http://%s-supervisor-agent:8000" .Release.Name) -}}
{{- end -}}

{{- define "autonomous-agents.dynamicAgentsUrl" -}}
{{- .Values.config.DYNAMIC_AGENTS_URL | default (printf "http://%s-dynamic-agents:8001" .Release.Name) -}}
{{- end -}}

{{/*
Default OAuth token endpoint for authenticated service-to-service calls to
Dynamic Agents. Operators using an external identity provider can override it
with dynamicAgentsAuth.tokenUrl.
*/}}
{{- define "autonomous-agents.dynamicAgentsTokenUrl" -}}
{{- .Values.dynamicAgentsAuth.tokenUrl | default (printf "http://%s-keycloak:8080/realms/caipe/protocol/openid-connect/token" .Release.Name) -}}
{{- end -}}
