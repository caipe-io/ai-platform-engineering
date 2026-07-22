{{/*
Expand the name of the chart.
*/}}
{{- define "litellm.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Create a default fully qualified app name.
*/}}
{{- define "litellm.fullname" -}}
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
Chart name and version as used by the chart label.
*/}}
{{- define "litellm.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Common labels.
*/}}
{{- define "litellm.labels" -}}
helm.sh/chart: {{ include "litellm.chart" . }}
{{ include "litellm.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{/*
Selector labels.
*/}}
{{- define "litellm.selectorLabels" -}}
app.kubernetes.io/name: {{ include "litellm.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
ServiceAccount name.
*/}}
{{- define "litellm.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (include "litellm.fullname" .) .Values.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.serviceAccount.name }}
{{- end }}
{{- end }}

{{/*
Name of the Secret holding the shared credential / proxy master_key.
Falls back to the umbrella global.llmSecrets secret when not overridden.
*/}}
{{- define "litellm.masterKeySecretName" -}}
{{- if .Values.masterKeySecret.name }}
{{- .Values.masterKeySecret.name }}
{{- else if and .Values.global .Values.global.llmSecrets .Values.global.llmSecrets.secretName }}
{{- .Values.global.llmSecrets.secretName }}
{{- else }}
{{- "llm-secret" }}
{{- end }}
{{- end }}

{{/*
Name of the proxy-only Secret holding the real upstream provider credentials.
Separate from the shared/master credential (litellm.masterKeySecretName) - agents never see it.
Empty when neither a referenced name nor create is set.
*/}}
{{- define "litellm.upstreamSecretName" -}}
{{- if .Values.upstreamSecret.create -}}
{{- printf "%s-upstream" (include "litellm.fullname" .) -}}
{{- else -}}
{{- .Values.upstreamSecret.name -}}
{{- end -}}
{{- end }}
