{{/*
Expand the name of the chart.
*/}}
{{- define "caipe-ui.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Create a default fully qualified app name.
We truncate at 63 chars because some Kubernetes name fields are limited to this (by the DNS naming spec).
If release name contains chart name it will be used as a full name.
*/}}
{{- define "caipe-ui.fullname" -}}
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
{{- define "caipe-ui.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Common labels
*/}}
{{- define "caipe-ui.labels" -}}
helm.sh/chart: {{ include "caipe-ui.chart" . }}
{{ include "caipe-ui.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/component: caipe-ui
{{- end }}

{{/*
Selector labels
*/}}
{{- define "caipe-ui.selectorLabels" -}}
app.kubernetes.io/name: {{ include "caipe-ui.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
Create the name of the service account to use
*/}}
{{- define "caipe-ui.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (include "caipe-ui.fullname" .) .Values.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.serviceAccount.name }}
{{- end }}
{{- end }}

{{/*
Determine if ingress is enabled - global takes precedence
*/}}
{{- define "caipe-ui.ingress.enabled" -}}
    {{- $global := (default dict .Values.global) -}}
    {{- if hasKey $global "ingress" -}}
        {{- $globalIngress := (default dict $global.ingress) -}}
        {{- if hasKey $globalIngress "enabled" -}}
            {{- $globalIngress.enabled -}}
        {{- else -}}
            {{- .Values.ingress.enabled | default false -}}
        {{- end -}}
    {{- else -}}
        {{- .Values.ingress.enabled | default false -}}
    {{- end -}}
{{- end }}

{{- define "caipe-ui.appVersion" -}}
{{- .Values.global.image.tag | default .Chart.AppVersion -}}
{{- end -}}


{{/* Slack provider credentials belong to the bot, never the UI. */}}
{{- define "caipe-ui.validate.slackCredentials" -}}
{{- $credentials := list "SLACK_BOT_TOKEN" "SLACK_APP_TOKEN" "SLACK_SIGNING_SECRET" "SLACK_INTEGRATION_BOT_TOKEN" "SLACK_INTEGRATION_APP_TOKEN" "SLACK_INTEGRATION_SIGNING_SECRET" -}}
{{- range $key := $credentials -}}
{{- if hasKey $.Values.config $key -}}
{{- fail (printf "%s belongs on slack-bot; remove it from caipe-ui.config" $key) -}}
{{- end -}}
{{- end -}}
{{- range .Values.externalSecrets.data -}}
{{- if has .secretKey $credentials -}}
{{- fail (printf "%s belongs on slack-bot; remove it from caipe-ui.externalSecrets.data" .secretKey) -}}
{{- end -}}
{{- end -}}
{{- end -}}
